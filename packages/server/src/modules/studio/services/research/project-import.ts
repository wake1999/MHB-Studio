/**
 * Import an existing LaTeX paper directory as a research project.
 *
 * The source tree is **copied** into `<research root>/projects/<id>/` — never
 * referenced in place — so the panel's edits and compiles cannot touch the
 * user's original files. Build outputs, VCS metadata and `node_modules` are
 * skipped; the entry `.tex` (the file carrying `\documentclass`) is reported
 * back so the panel knows what it is editing.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { researchRoot, updateStore, newId } from './store'

/** Hard caps: a paper directory is small; anything bigger is a mistake. */
const MAX_FILES = 3_000
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_DEPTH = 24

/** Directories that never belong to a paper source tree. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '__pycache__', '.venv', '.idea', '.vscode'])
/** Extensions that count as a figure. */
const FIGURE_EXT = /\.(png|jpe?g|pdf|svg|eps|gif|webp)$/i

export interface ImportedProject {
  projectId: string
  title: string
  /** The copied tree, relative to the research root (`projects/<id>`). */
  paperDir: string
  /** Entry `.tex` basename (the file carrying `\documentclass`). */
  entryTex: string
  figureCount: number
  warnings: string[]
}

interface Walked {
  files: Array<{ rel: string; abs: string; bytes: number }>
  totalBytes: number
}

/** Expand `~`, then require an existing directory. */
async function resolveSource(raw: string): Promise<string> {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('import_path_empty')
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed
  const absolute = path.resolve(expanded)
  const stat = await fs.stat(absolute).catch(() => null)
  if (stat === null) throw new Error('import_path_missing')
  if (!stat.isDirectory()) throw new Error('import_path_not_dir')
  return absolute
}

async function walk(root: string): Promise<Walked> {
  const files: Walked['files'] = []
  let totalBytes = 0
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await visit(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(abs).catch(() => null)
      if (stat === null) continue
      totalBytes += stat.size
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('import_too_large')
      files.push({ rel: path.relative(root, abs), abs, bytes: stat.size })
    }
  }
  await visit(root, 0)
  return { files, totalBytes }
}

/** The first `\title{...}` of a `.tex` file, '' when absent. */
function titleOf(tex: string): string {
  const match = /\\title\s*(?:\[[^\]]*\])?\s*\{/.exec(tex)
  if (match === null) return ''
  let depth = 0
  for (let index = match.index + match[0].length - 1; index < tex.length; index += 1) {
    const char = tex[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return tex.slice(match.index + match[0].length, index).replace(/\\\\/g, ' ').trim()
    }
  }
  return ''
}

/**
 * Copy `request.path` in as a new project.
 * @param profile - research profile.
 * @param request - the source directory (absolute or `~`-prefixed) and an optional title.
 * @returns the new project's summary, plus non-fatal caveats.
 */
export async function importProject(
  profile: string | undefined,
  request: { path: string; title?: string },
): Promise<ImportedProject> {
  const source = await resolveSource(request.path)
  const walked = await walk(source)
  if (walked.files.length === 0) throw new Error('import_empty_dir')

  const texFiles = walked.files.filter(file => file.rel.toLowerCase().endsWith('.tex'))
  if (texFiles.length === 0) throw new Error('import_no_tex')

  // The entry file is the one with \documentclass; `main.tex` wins a tie.
  let entry = ''
  let entryTex = ''
  for (const file of texFiles) {
    const text = await fs.readFile(file.abs, 'utf-8').catch(() => '')
    if (!text.includes('\\documentclass')) continue
    if (file.rel === 'main.tex') {
      entry = file.rel
      entryTex = text
      break
    }
    if (entry === '') {
      entry = file.rel
      entryTex = text
    }
  }
  if (entry === '') throw new Error('import_no_entry')

  const projectId = newId('proj')
  const target = path.join(researchRoot(profile), 'projects', projectId)
  for (const file of walked.files) {
    const destination = path.join(target, file.rel)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(file.abs, destination)
  }

  const title = (request.title ?? '').trim() || titleOf(entryTex) || path.basename(source)
  const figuresDir = walked.files.filter(file => /^figures?[/\\]/i.test(file.rel))
  const figurePool = figuresDir.length > 0 ? figuresDir : walked.files
  const figureCount = figurePool.filter(file => FIGURE_EXT.test(file.rel)).length

  const warnings: string[] = []
  if (figuresDir.length === 0) warnings.push('源目录里没有 figures/，图表按全目录统计')
  if (!walked.files.some(file => file.rel.toLowerCase().endsWith('.bib'))) warnings.push('没有找到 .bib，参考文献需要另外补')
  if (entry !== 'main.tex') warnings.push(`入口文件是 ${entry}，编辑器仍会写 main.tex：需要手动改名`)
  if (walked.files.some(file => SKIP_DIRS.has(file.rel.split(/[/\\]/)[0] ?? ''))) {
    warnings.push('源目录里含构建产物或版本库目录，已跳过')
  }

  await updateStore(profile, 'projects.imported', store => {
    store.projects.unshift({ id: projectId, title, createdAt: Date.now(), updatedAt: Date.now() })
    return projectId
  })

  return {
    projectId,
    title,
    paperDir: `projects/${projectId}`,
    entryTex: path.basename(entry),
    figureCount,
    warnings,
  }
}
