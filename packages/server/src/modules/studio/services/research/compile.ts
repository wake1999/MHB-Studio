/**
 * Real LaTeX compilation.
 *
 * Runs latexmk (or pdflatex twice as a fallback) inside the project directory and
 * keeps the tail of the log plus a `compile.json` next to the source, so a panel
 * reload after a restart still knows what happened. Long runs are bounded by a
 * timeout; a timeout is reported as a failure with the reason, never as success.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { detectCompileEnvironment, paperPdfPath, paperSourcePath } from './paper'
import { researchRoot } from './store'

const run = promisify(execFile)
const TIMEOUT_MS = 240_000
const MAX_BUFFER = 8 * 1024 * 1024
const LOG_TAIL = 6000

export interface CompileResult {
  projectId: string
  ok: boolean
  engine: string
  exitCode: number
  durationMs: number
  at: number
  logTail: string
  logPath: string
  pdfPath: string
  pdfBytes: number
  timedOut: boolean
}

function projectDir(projectId: string, profile?: string): string {
  return path.join(researchRoot(profile), 'projects', projectId)
}

function metaPath(projectId: string, profile?: string): string {
  return path.join(projectDir(projectId, profile), 'compile.json')
}

async function tail(text: string): Promise<string> {
  const cleaned = text.split('\n').slice(-400).join('\n').trim()
  return cleaned.length > LOG_TAIL ? cleaned.slice(-LOG_TAIL) : cleaned
}

export async function readLastCompile(projectId: string, profile?: string): Promise<CompileResult | null> {
  try {
    const raw = await fs.readFile(metaPath(projectId, profile), 'utf-8')
    return JSON.parse(raw) as CompileResult
  } catch {
    return null
  }
}

export async function runCompile(projectId: string, profile?: string): Promise<CompileResult> {
  const dir = projectDir(projectId, profile)
  const source = paperSourcePath(projectId, profile)
  const pdf = paperPdfPath(projectId, profile)
  const started = Date.now()

  const sourceExists = await fs.access(source).then(() => true, () => false)
  if (!sourceExists) {
    const result: CompileResult = {
      projectId,
      ok: false,
      engine: '',
      exitCode: -1,
      durationMs: 0,
      at: Date.now(),
      logTail: '还没有 main.tex，先保存一次源码。',
      logPath: '',
      pdfPath: pdf,
      pdfBytes: 0,
      timedOut: false,
    }
    await persist(projectId, profile, result)
    return result
  }

  const environment = await detectCompileEnvironment()
  let output = ''
  let exitCode = 0
  let timedOut = false
  let engine: string = environment.engine

  const attempts: Array<{ bin: string; args: string[]; label: string }> = []
  if (environment.engine === 'latexmk') {
    attempts.push({
      bin: 'latexmk',
      args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex'],
      label: 'latexmk',
    })
  } else if (environment.engine === 'tectonic') {
    attempts.push({ bin: 'tectonic', args: ['--keep-logs', 'main.tex'], label: 'tectonic' })
  } else if (environment.engine === 'xelatex') {
    attempts.push({ bin: 'xelatex', args: ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], label: 'xelatex' })
    attempts.push({ bin: 'xelatex', args: ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], label: 'xelatex(2)' })
  } else {
    attempts.push({ bin: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], label: 'pdflatex' })
    attempts.push({ bin: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], label: 'pdflatex(2)' })
  }

  for (const attempt of attempts) {
    engine = attempt.label
    try {
      const { stdout, stderr } = await run(attempt.bin, attempt.args, {
        cwd: dir,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, max_print_line: '1000' },
      })
      output += `$ ${attempt.bin} ${attempt.args.join(' ')}\n${stdout}\n${stderr}\n`
      exitCode = 0
    } catch (error: any) {
      exitCode = typeof error?.code === 'number' ? error.code : -1
      timedOut = Boolean(error?.killed) || error?.signal === 'SIGTERM'
      output += `$ ${attempt.bin} ${attempt.args.join(' ')}\n${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}\n`
      break
    }
  }

  let pdfBytes = 0
  try {
    pdfBytes = (await fs.stat(pdf)).size
  } catch {
    pdfBytes = 0
  }

  const logPath = path.join(dir, 'build.log')
  await fs.writeFile(logPath, output, 'utf-8').catch(() => undefined)

  const result: CompileResult = {
    projectId,
    ok: exitCode === 0 && pdfBytes > 0,
    engine,
    exitCode,
    durationMs: Date.now() - started,
    at: Date.now(),
    logTail: await tail(output),
    logPath,
    pdfPath: pdf,
    pdfBytes,
    timedOut,
  }
  await persist(projectId, profile, result)
  return result
}

async function persist(projectId: string, profile: string | undefined, result: CompileResult): Promise<void> {
  const dir = projectDir(projectId, profile)
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  await fs.writeFile(metaPath(projectId, profile), `${JSON.stringify(result, null, 2)}\n`, 'utf-8').catch(() => undefined)
}
