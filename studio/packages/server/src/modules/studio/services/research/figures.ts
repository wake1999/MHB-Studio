/**
 * Figure conversion: the LaTeX-embeddable product of one figure file.
 *
 * Upstream runs the panel's `convertFigure` against a converter chain; ekko
 * only needs the one case the panel actually hits (an SVG chart saved from the
 * experiments view must become a PDF before `\includegraphics` can use it).
 * Everything else is already embeddable and comes back as `cached`.
 *
 * The converter is looked up on PATH (`rsvg-convert`); a machine without it
 * fails with `no_converter`, which the controller maps to a 501 and the panel
 * shows as a warning rather than a crash.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { paperSourcePath } from './paper'

const exec = promisify(execFile)

/** Same guard the paper service uses: only plain relative paths inside a project. */
const FIGURE_PATH = /^[A-Za-z0-9_./\\-]{1,260}$/

/** Extensions that are already usable by `\includegraphics`. */
const EMBEDDABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp'])

/** How long one converter run may take before it is killed. */
const CONVERT_TIMEOUT_MS = 20_000

export interface ConvertedFigure {
  /** Path relative to the project directory (`figures/foo.pdf`). */
  relPath: string
  /** `rsvg-convert` when this call produced it, `cached` when it already existed. */
  converter: string
}

function projectRoot(projectId: string, profile?: string): string {
  return path.dirname(paperSourcePath(projectId, profile))
}

/** Resolve one figure inside the project directory; never outside it. */
function figureTarget(projectId: string, relPath: string, profile?: string): string {
  if (!FIGURE_PATH.test(relPath)) throw new Error('invalid_figure_path')
  const root = path.resolve(projectRoot(projectId, profile))
  const target = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(root, relPath)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('invalid_figure_path')
  return target
}

/**
 * Produce the embeddable sibling of one figure.
 * @param projectId - the project whose directory holds the figure.
 * @param relPath - project-relative (or absolute-inside-project) figure path.
 * @param profile - research profile.
 * @returns the product's project-relative path and the converter that made it.
 */
export async function convertProjectFigure(
  projectId: string,
  relPath: string,
  profile?: string,
): Promise<ConvertedFigure> {
  const root = path.resolve(projectRoot(projectId, profile))
  const target = figureTarget(projectId, relPath, profile)
  const stat = await fs.stat(target).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error('figure_not_found')

  const ext = path.extname(target).toLowerCase()
  if (EMBEDDABLE.has(ext)) return { relPath: path.relative(root, target), converter: 'cached' }
  if (ext !== '.svg') throw new Error('unsupported_figure_type')

  const product = target.slice(0, -'.svg'.length) + '.pdf'
  const existing = await fs.stat(product).catch(() => null)
  if (existing && existing.isFile() && existing.mtimeMs >= stat.mtimeMs) {
    return { relPath: path.relative(root, product), converter: 'cached' }
  }

  try {
    await exec('rsvg-convert', ['-f', 'pdf', '-o', product, target], { timeout: CONVERT_TIMEOUT_MS })
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error('no_converter')
    const detail = typeof error?.stderr === 'string' && error.stderr.trim() !== ''
      ? error.stderr.trim().split('\n').slice(-1)[0]
      : (error?.message || 'unknown')
    throw new Error(`converter_failed: ${detail}`)
  }
  return { relPath: path.relative(root, product), converter: 'rsvg-convert' }
}
