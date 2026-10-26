import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const result = await stat(filePath)
    return { mtime: Math.round(result.mtimeMs) }
  } catch {
    return null
  }
}

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const DESCRIPTION_FIELD = /^description\s*:(.*)$/i
const BLOCK_SCALAR = /^([|>])/

/** Folds a YAML value onto one line so it can be shown as a standfirst or tooltip. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  if (first === '"' && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\/nrt])/g, (_, ch: string) =>
      ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
    )
  }
  if (first === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/** Collects the indented lines that belong to a frontmatter value, dedented from the block's common indent. */
function readIndentedLines(lines: string[], from: number): string[] {
  const block: string[] = []
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      block.push('')
      continue
    }
    if (!/^[ \t]/.test(line)) break
    block.push(line)
  }
  const indents = block.filter(line => line !== '').map(line => /^[ \t]*/.exec(line)![0].length)
  const indent = indents.length ? Math.min(...indents) : 0
  return block.map(line => line.slice(Math.min(indent, line.length)))
}

/** `>` folds single breaks into spaces, `|` keeps them. Both are collapsed by the caller. */
function readBlockScalar(lines: string[], from: number, style: string): string {
  const block = readIndentedLines(lines, from)
  if (style === '|') return block.join('\n')
  let folded = ''
  for (const line of block) {
    if (folded === '') folded = line
    else if (line === '') folded += '\n'
    else if (folded.endsWith('\n')) folded += line
    else folded += ` ${line}`
  }
  return folded
}

function readFrontmatterDescription(frontmatter: string): string {
  const lines = frontmatter.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = DESCRIPTION_FIELD.exec(lines[i])
    if (!match) continue
    const rest = match[1].trim()
    if (!rest) return collapse(readIndentedLines(lines, i + 1).join('\n'))
    const style = BLOCK_SCALAR.exec(rest)
    if (style) return collapse(readBlockScalar(lines, i + 1, style[1]))
    if (rest[0] !== '"' && rest[0] !== "'") {
      const continued = readIndentedLines(lines, i + 1)
      if (continued.length) return collapse([rest, ...continued].join('\n'))
    }
    return collapse(stripQuotes(rest))
  }
  return ''
}

export function extractDescription(content: string): string {
  const frontmatter = FRONTMATTER_BLOCK.exec(content)
  if (frontmatter) {
    const described = readFrontmatterDescription(frontmatter[1])
    if (described) return described
  }
  const lines = content.split('\n')
  let inFrontmatter = false
  let bodyStarted = false
  for (const line of lines) {
    if (!bodyStarted && line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      }
      inFrontmatter = false
      bodyStarted = true
      continue
    }
    if (inFrontmatter || line.trim() === '' || line.startsWith('#')) continue
    return line.trim().slice(0, 80)
  }
  return ''
}

export async function listFilesRecursive(dir: string, prefix: string): Promise<Array<{ path: string; name: string }>> {
  const result: Array<{ path: string; name: string }> = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await listFilesRecursive(join(dir, entry.name), relPath))
    else result.push({ path: relPath, name: entry.name })
  }
  return result
}
