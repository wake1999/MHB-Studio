/**
 * Paper source, outline, snapshots and compile readiness.
 *
 * Source lives on disk at `.research/projects/<projectId>/main.tex` so the agent
 * can open it with ordinary file tools and latexmk can be pointed at a real
 * directory. Snapshots are plain copies under `snapshots/`, recorded in the
 * store so the panel can list and restore them.
 */
import { execFile } from 'node:child_process'
import { createReadStream, promises as fs, type ReadStream } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { parseBibtex, serializeBibtex, type BibEntry } from './bibtex'
import { researchRoot } from './store'

const run = promisify(execFile)
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/
// 只拦路径分隔符与 `..`：早期版本允许中文 label 落成中文文件名，
// 用 ASCII 白名单会把那些已有快照判成「文件丢失」，读不回来。
const SNAPSHOT_FILE = /^(?!.*\.\.)[^/\\]{1,120}$/
const MAX_SOURCE_BYTES = 1024 * 1024

export const DEFAULT_TEX = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx,booktabs}
\\usepackage{hyperref}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}

\\section{Method}
\\label{sec:method}

\\section{Experiments}
\\label{sec:experiments}

\\section{Conclusion}
\\label{sec:conclusion}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`

export interface OutlineNode {
  id: string
  /** 1 = section, 2 = subsection, 3 = subsubsection. */
  level: number
  title: string
  label: string
  /** 1-based source line carrying the heading command. */
  line: number
  /** Child headings; the panel renders the outline as a tree. */
  children: OutlineNode[]
}

export interface CompileEnvironment {
  engine: 'latexmk' | 'tectonic' | 'xelatex' | ''
  available: boolean
  detail: string
}

export function projectDir(projectId: string, profile?: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid_project_id')
  return path.join(researchRoot(profile), 'projects', projectId)
}

export function paperSourcePath(projectId: string, profile?: string): string {
  return path.join(projectDir(projectId, profile), 'main.tex')
}

export function paperPdfPath(projectId: string, profile?: string): string {
  return path.join(projectDir(projectId, profile), 'main.pdf')
}

/**
 * Open `main.pdf` for the panel's preview. Streamed rather than buffered so a
 * 20-page paper does not sit in memory on every scroll/refresh.
 */
export async function openPaperPdf(
  projectId: string,
  profile?: string,
): Promise<{ stream: ReadStream; size: number; updatedAt: number }> {
  const file = paperPdfPath(projectId, profile)
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || !stat.isFile() || stat.size === 0) throw new Error('pdf_not_found')
  return { stream: createReadStream(file), size: stat.size, updatedAt: stat.mtimeMs }
}

/** One recognized heading command, longest first so `sub` prefixes win. */
const OUTLINE_COMMANDS = [
  { command: 'subsubsection', level: 3 },
  { command: 'subsection', level: 2 },
  { command: 'section', level: 1 },
] as const

/** The first balanced `{...}` group starting at `open` (the `{` index). */
function outlineBraceGroup(text: string, open: number): string | undefined {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
  }
  return undefined
}

/** Read one heading command at `start` (the index just past the backslash). */
function outlineHeadingAt(line: string, start: number): { level: number; title: string } | undefined {
  for (const { command, level } of OUTLINE_COMMANDS) {
    if (!line.startsWith(command, start)) continue
    let cursor = start + command.length
    if (line[cursor] === '*') cursor += 1
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1
    if (line[cursor] === '[') {
      const close = line.indexOf(']', cursor)
      if (close === -1) return undefined
      cursor = close + 1
      while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1
    }
    if (line[cursor] !== '{') return undefined
    const title = outlineBraceGroup(line, cursor)
    if (title === undefined) return undefined
    return { level, title: title.trim() }
  }
  return undefined
}

/**
 * `\section{}` / `\subsection{}` / `\subsubsection{}` parsed into the tree the
 * research panel renders, with 1-based line numbers. Comment lines and
 * verbatim blocks are skipped, so a heading-like line inside either never
 * enters the tree. A label belongs to the heading it follows, so the search
 * stops at the next heading.
 */
export function outlineFromSource(source: string): OutlineNode[] {
  const lines = source.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }

  const headings: Array<{ level: number; title: string; line: number; at: number }> = []
  let verbatim = false
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (/^\\begin\{verbatim\*?\}/.test(trimmed)) {
      verbatim = true
      continue
    }
    if (/^\\end\{verbatim\*?\}/.test(trimmed)) {
      verbatim = false
      continue
    }
    if (verbatim || trimmed.startsWith('%')) continue
    const slash = raw.indexOf('\\')
    if (slash === -1) continue
    const heading = outlineHeadingAt(raw, slash + 1)
    if (heading === undefined) continue
    headings.push({ level: heading.level, title: heading.title, line: index + 1, at: offsets[index] })
  }

  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  headings.forEach((entry, index) => {
    const next = headings[index + 1]
    const stop = Math.min(next ? next.at : source.length, entry.at + 400)
    const label = source.slice(entry.at, stop).match(/\\label\{([^{}]*)\}/)
    const node: OutlineNode = {
      id: `h${index + 1}`,
      level: entry.level,
      title: entry.title || '(未命名)',
      label: label ? label[1].trim() : '',
      line: entry.line,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  })
  return roots
}

export interface PaperSource {
  projectId: string
  path: string
  source: string
  exists: boolean
  bytes: number
  updatedAt: number
  outline: OutlineNode[]
}

export async function readPaperSource(projectId: string, profile?: string): Promise<PaperSource> {
  const target = paperSourcePath(projectId, profile)
  try {
    const stat = await fs.stat(target)
    const source = await fs.readFile(target, 'utf-8')
    return {
      projectId,
      path: target,
      source,
      exists: true,
      bytes: stat.size,
      updatedAt: stat.mtimeMs,
      outline: outlineFromSource(source),
    }
  } catch {
    // 首次读取时把模板落盘：否则编辑器里看到的是内存里的 DEFAULT_TEX、磁盘上没有
    // main.tex，用户点「编译」只会得到 "还没有 main.tex"，且无法自行修复。
    // 写盘失败（目录不可写）时退回原来的只读行为，不改变接口语义。
    const source = DEFAULT_TEX
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, source, 'utf-8')
      stat = await fs.stat(target)
    } catch {
      stat = null
    }
    return {
      projectId,
      path: target,
      source,
      exists: stat !== null,
      bytes: stat === null ? 0 : stat.size,
      updatedAt: stat === null ? 0 : stat.mtimeMs,
      outline: outlineFromSource(source),
    }
  }
}

export async function writePaperSource(
  projectId: string,
  source: string,
  profile?: string,
): Promise<PaperSource> {
  const bytes = Buffer.byteLength(source, 'utf-8')
  if (bytes > MAX_SOURCE_BYTES) {
    const error = new Error('source_too_large')
    ;(error as NodeJS.ErrnoException).code = 'file_too_large'
    throw error
  }
  const dir = projectDir(projectId, profile)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'main.tex')
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, source, 'utf-8')
  await fs.rename(tmp, target)
  const stat = await fs.stat(target)
  return {
    projectId,
    path: target,
    source,
    exists: true,
    bytes: stat.size,
    updatedAt: stat.mtimeMs,
    outline: outlineFromSource(source),
  }
}

export async function writeSnapshotFile(
  projectId: string,
  label: string,
  source: string,
  profile?: string,
): Promise<{ file: string; bytes: number }> {
  const dir = projectDir(projectId, profile)
  const snapshots = path.join(dir, 'snapshots')
  await fs.mkdir(snapshots, { recursive: true })
  // 毫秒级时间戳 + 纯 ASCII slug：中文 label 会把文件名写成中文，跨平台与
  // 读回校验都容易出问题；可读的 label 存在 store 记录里，文件名只需要唯一。
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)
  const slug = label.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'snapshot'
  const file = `${stamp}-${slug}.tex`
  const target = path.join(snapshots, file)
  await fs.writeFile(target, source, 'utf-8')
  const stat = await fs.stat(target)
  return { file, bytes: stat.size }
}

export async function readSnapshotFile(
  projectId: string,
  file: string,
  profile?: string,
): Promise<string> {
  if (!SNAPSHOT_FILE.test(file)) throw new Error('invalid_snapshot_file')
  return fs.readFile(path.join(projectDir(projectId, profile), 'snapshots', file), 'utf-8')
}

const ENGINE_CANDIDATES: Array<{ name: CompileEnvironment['engine']; bin: string }> = [
  { name: 'latexmk', bin: 'latexmk' },
  { name: 'tectonic', bin: 'tectonic' },
  { name: 'xelatex', bin: 'xelatex' },
]

export async function detectCompileEnvironment(): Promise<CompileEnvironment> {
  for (const candidate of ENGINE_CANDIDATES) {
    try {
      const { stdout } = await run('which', [candidate.bin], { timeout: 4000 })
      const found = stdout.trim()
      if (found) {
        return { engine: candidate.name, available: true, detail: found }
      }
    } catch {
      // Try the next engine.
    }
  }
  return { engine: '', available: false, detail: '未找到 latexmk / tectonic / xelatex' }
}

export interface CompileStatus {
  projectId: string
  environment: CompileEnvironment
  sourcePath: string
  sourceExists: boolean
  sourceUpdatedAt: number
  pdfPath: string
  hasPdf: boolean
  pdfUpdatedAt: number
  pdfBytes: number
  /** True when the PDF is newer than the source: the last build is current. */
  upToDate: boolean
}

export async function readCompileStatus(projectId: string, profile?: string): Promise<CompileStatus> {
  const environment = await detectCompileEnvironment()
  const sourcePath = paperSourcePath(projectId, profile)
  const pdfPath = paperPdfPath(projectId, profile)
  let sourceExists = false
  let sourceUpdatedAt = 0
  let hasPdf = false
  let pdfUpdatedAt = 0
  let pdfBytes = 0
  try {
    const stat = await fs.stat(sourcePath)
    sourceExists = true
    sourceUpdatedAt = stat.mtimeMs
  } catch {
    // No source yet.
  }
  try {
    const stat = await fs.stat(pdfPath)
    hasPdf = true
    pdfUpdatedAt = stat.mtimeMs
    pdfBytes = stat.size
  } catch {
    // Never compiled.
  }
  return {
    projectId,
    environment,
    sourcePath,
    sourceExists,
    sourceUpdatedAt,
    pdfPath,
    hasPdf,
    pdfUpdatedAt,
    pdfBytes,
    upToDate: hasPdf && sourceExists && pdfUpdatedAt >= sourceUpdatedAt,
  }
}

const FIGURE_PATH = /^[A-Za-z0-9_./\\-]{1,260}$/
const FIGURE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}

/**
 * Read one figure file of a project. `relPath` is either relative to the
 * project directory (`figures/foo.png`) or an absolute path inside it; anything
 * escaping the directory is rejected.
 */
export async function readProjectFigure(
  projectId: string,
  relPath: string,
  profile?: string,
): Promise<{ bytes: Buffer; contentType: string; size: number; mtimeMs: number }> {
  if (!FIGURE_PATH.test(relPath)) throw new Error('invalid_figure_path')
  const root = path.resolve(projectDir(projectId, profile))
  const target = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(root, relPath)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('invalid_figure_path')
  const stat = await fs.stat(target).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error('figure_not_found')
  if (stat.size > 32 * 1024 * 1024) throw new Error('figure_too_large')
  const bytes = await fs.readFile(target)
  const contentType = FIGURE_TYPES[path.extname(target).toLowerCase()]
  if (!contentType) throw new Error('unsupported_figure_type')
  return { bytes, contentType, size: stat.size, mtimeMs: stat.mtimeMs }
}

/** Resolve one figure path inside this project's directory (never outside). */
function figureTarget(projectId: string, relPath: string, profile?: string): string {
  if (!FIGURE_PATH.test(relPath)) throw new Error('invalid_figure_path')
  const root = path.resolve(projectDir(projectId, profile))
  const target = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(root, relPath)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('invalid_figure_path')
  return target
}

/** Rename one figure file in place; the store record is patched by the caller. */
export async function renameProjectFigure(
  projectId: string,
  relPath: string,
  newName: string,
  profile?: string,
): Promise<{ newPath: string }> {
  if (!FIGURE_PATH.test(newName) || /[/\\]/.test(newName) || newName.startsWith('.')) {
    throw new Error('invalid_figure_name')
  }
  const target = figureTarget(projectId, relPath, profile)
  const stat = await fs.stat(target).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error('figure_not_found')
  const renamed = path.join(path.dirname(target), newName)
  if (renamed === target) return { newPath: target }
  const clash = await fs.stat(renamed).catch(() => null)
  if (clash) throw new Error('figure_exists')
  await fs.rename(target, renamed)
  return { newPath: renamed }
}

/** Delete one figure file; the store record is dropped by the caller. */
export async function deleteProjectFigure(projectId: string, relPath: string, profile?: string): Promise<void> {
  const target = figureTarget(projectId, relPath, profile)
  await fs.rm(target, { force: true })
}

/**
 * Write one uploaded figure into the project's paper directory (`figures/` by
 * default, or under the caller's `dir`). The resolved path never leaves the
 * project directory, and an existing file with the same name is overwritten so
 * a re-upload replaces the old bytes instead of piling up copies.
 */
export async function saveProjectFigure(
  projectId: string,
  dir: string,
  name: string,
  bytes: Buffer,
  profile?: string,
): Promise<{ path: string; relPath: string }> {
  if (!FIGURE_PATH.test(name) || /[/\\]/.test(name) || name.startsWith('.')) throw new Error('invalid_figure_name')
  const root = path.resolve(projectDir(projectId, profile))
  const folder = dir.trim() === '' ? 'figures' : dir.trim()
  if (!FIGURE_PATH.test(folder)) throw new Error('invalid_figure_path')
  const targetDir = path.resolve(root, folder)
  if (targetDir !== root && !targetDir.startsWith(root + path.sep)) throw new Error('invalid_figure_path')
  await fs.mkdir(targetDir, { recursive: true })
  const target = path.join(targetDir, name)
  await fs.writeFile(target, bytes)
  return { path: target, relPath: path.relative(root, target) }
}


/* --------------------------------------------------------- bibliography */

/** 项目论文目录下的 `references.bib`（与 main.tex 同目录，latexmk 才找得到）。 */
export function bibliographyPath(projectId: string, profile?: string): string {
  return path.join(projectDir(projectId, profile), 'references.bib')
}

export interface BibliographySource {
  projectId: string
  path: string
  entries: BibEntry[]
  /** 乐观并发的基准；文件不存在时为 null。 */
  mtimeMs: number | null
}

/**
 * 读项目参考文献。文件不存在是**成功**的空列表（面板把「还没有文献」当正常状态），
 * 不是错误。
 */
export async function readBibliography(projectId: string, profile?: string): Promise<BibliographySource> {
  const target = bibliographyPath(projectId, profile)
  try {
    const stat = await fs.stat(target)
    const text = await fs.readFile(target, 'utf-8')
    return { projectId, path: target, entries: parseBibtex(text), mtimeMs: stat.mtimeMs }
  } catch {
    return { projectId, path: target, entries: [], mtimeMs: null }
  }
}

/** 抛一个带 code 的错误，交给 controller 映射成 HTTP 状态。 */
function bibError(code: string, extra?: Record<string, unknown>): Error {
  const error = new Error(code) as Error & Record<string, unknown>
  error.code = code
  if (extra) Object.assign(error, extra)
  return error
}

/**
 * 整体替换 `references.bib`，带乐观并发：
 * - `baseMtimeMs === null` 表示「我读到的是不存在的文件」，此时文件已存在 → conflict；
 * - 否则文件 mtime 必须仍等于 base（容差 1ms，文件系统精度），不等 → conflict
 *   并带回 `currentMtimeMs`；
 * - `baseMtimeMs` 非空但文件已消失 → `bib_not_found`。
 */
export async function writeBibliography(
  projectId: string,
  entries: readonly BibEntry[],
  baseMtimeMs: number | null,
  profile?: string,
): Promise<{ mtimeMs: number }> {
  const text = serializeBibtex(entries)
  if (Buffer.byteLength(text, 'utf-8') > MAX_SOURCE_BYTES) throw bibError('file_too_large')
  const target = bibliographyPath(projectId, profile)
  const stat = await fs.stat(target).catch(() => null)
  const currentMtimeMs = stat === null ? null : stat.mtimeMs
  if (baseMtimeMs === null && currentMtimeMs !== null) {
    throw bibError('conflict', { currentMtimeMs })
  }
  if (baseMtimeMs !== null && currentMtimeMs === null) throw bibError('bib_not_found')
  if (baseMtimeMs !== null && currentMtimeMs !== null && Math.abs(currentMtimeMs - baseMtimeMs) > 1) {
    throw bibError('conflict', { currentMtimeMs })
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, 'utf-8')
  await fs.rename(tmp, target)
  const after = await fs.stat(target)
  return { mtimeMs: after.mtimeMs }
}

export interface BibAppendResult {
  /** 新写进去的引用键。 */
  added: string[]
  /** 已在文件里、跳过的引用键。 */
  skipped: string[]
}

/**
 * 把一批条目追加到 `references.bib`，跳过已存在的引用键（键为空也跳过，宁可少写
 * 也不写一条 `@misc{}`）。读-合并-写在一次调用内完成；撞上并发写就重读重试一次。
 */
export async function appendBibliographyEntries(
  projectId: string,
  entries: readonly BibEntry[],
  profile?: string,
): Promise<BibAppendResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readBibliography(projectId, profile)
    const keys = new Set(current.entries.map(entry => entry.key))
    const added: string[] = []
    const skipped: string[] = []
    const merged = [...current.entries]
    for (const entry of entries) {
      if (entry.key === '' || keys.has(entry.key)) {
        skipped.push(entry.key)
        continue
      }
      keys.add(entry.key)
      merged.push(entry)
      added.push(entry.key)
    }
    if (added.length === 0) return { added, skipped }
    try {
      await writeBibliography(projectId, merged, current.mtimeMs, profile)
      return { added, skipped }
    } catch (error: any) {
      if (error?.code !== 'conflict' || attempt === 1) throw error
    }
  }
  return { added: [], skipped: [] }
}


/**
 * 回滚专用：在 `writePaperSource` 外面套一层乐观并发。`baseMtimeMs` 是调用方读到
 * `main.tex` 时的 mtime，与磁盘一致才写；不一致抛 `conflict` 并带回当前 mtime，
 * 交给面板冻结编辑器重新载入——回滚会覆盖整份源码，静默盖掉用户没看到的编辑是不可
 * 接受的。容差 1ms，抵消文件系统时间精度。
 */
export async function writePaperSourceOptimistic(
  projectId: string,
  source: string,
  baseMtimeMs: number | null,
  profile?: string,
): Promise<PaperSource> {
  const target = paperSourcePath(projectId, profile)
  const stat = await fs.stat(target).catch(() => null)
  const current = stat === null ? null : stat.mtimeMs
  if (baseMtimeMs === null && current !== null) {
    throw Object.assign(new Error('conflict'), { code: 'conflict', currentMtimeMs: current })
  }
  if (baseMtimeMs !== null && current === null) {
    throw Object.assign(new Error('paper_not_found'), { code: 'paper_not_found' })
  }
  if (baseMtimeMs !== null && current !== null && Math.abs(current - baseMtimeMs) > 1) {
    throw Object.assign(new Error('conflict'), { code: 'conflict', currentMtimeMs: current })
  }
  return writePaperSource(projectId, source, profile)
}
