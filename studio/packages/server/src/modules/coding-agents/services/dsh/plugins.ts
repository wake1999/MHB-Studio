import { DshPluginError } from './errors'
import { dshInstallation } from './installation'
import { readDshWebPackages } from './plugin-inventory'

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/
const GITHUB = /^github:[\w.-]+\/[\w.-]+(?:#[A-Za-z0-9._/-]{1,64})?$/

/**
 * The one grammar every install surface shares — the settings list and the market
 * page alike: an npm name, `name@exact-version`, or `github:owner/repo` with an
 * optional ref. Returns the spec to install, or '' when it is not installable.
 */
export function dshInstallSpec(spec: string): string {
  const value = spec.trim()
  if (value === '' || value.length >= 512) return ''
  if (GITHUB.test(value)) return value
  const split = value.lastIndexOf('@')
  const name = split > 0 ? value.slice(0, split) : value
  const version = split > 0 ? value.slice(split + 1) : ''
  if (!NAME.test(name)) return ''
  if (version !== '' && !VERSION.test(version)) return ''
  return value
}

export function nativePluginArgs(body: any): string[] {
  if (body?.action === 'remove' && typeof body.packageName === 'string' && NAME.test(body.packageName)) return ['plugin', '--profile', 'web', 'remove', body.packageName]
  if (body?.action === 'install' && typeof body.packageSpec === 'string') {
    const spec = dshInstallSpec(body.packageSpec)
    if (spec !== '') return ['plugin', '--profile', 'web', 'add', spec]
  }
  throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Use an npm package name (optionally @exact-version) or github:owner/repo#ref')
}
const running = new Map<string, AbortController>()
export async function shutdownDshPluginOperations() { for (const abort of running.values()) abort.abort() }
export async function changeNativeDshPlugins(input: { command: string; sourceHome: string; body: any; revision: string;
  execute(home: string, args: string[], signal: AbortSignal): Promise<void> }) {
  const args = nativePluginArgs(input.body)
  if (running.has(input.sourceHome)) throw new DshPluginError(409, 'DSH_OPERATION_CONFLICT', 'Another Web plugin operation is running')
  const abort = new AbortController(); running.set(input.sourceHome, abort)
  try {
    const { web } = await readDshWebPackages(await dshInstallation(input.command), input.sourceHome)
    if (!input.revision || input.revision !== web.revision) throw new DshPluginError(412, 'DSH_REVISION_CHANGED', 'Web profile changed; reload before continuing')
    if (input.body.action === 'remove' && !web.packages.some(pkg => pkg.name === input.body.packageName)) throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Package is not installed in the Web profile')
    await input.execute(input.sourceHome, args, abort.signal)
  } finally { running.delete(input.sourceHome) }
}
