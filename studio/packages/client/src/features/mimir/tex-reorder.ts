/**
 * 论文源码里 `\section` / `\subsection` 的重排。
 *
 * 面板的拖拽只给"s 标题 + 目标下标"，真正的换行由这里完成：源码按行切成
 * 前导（preamble）、各 section 块、块尾（`\end{document}` 之后），然后做一次
 * 行置换再拼回去。块以外的每一行都原样保留，所以重排不会顺手改格式。
 *
 * 解析规则与上游一致：注释行（首个非空字符是 `%`）与 `verbatim` 环境里的
 * 标题不算标题，`\section*` 与 `\section[短标题]{标题}` 都认。
 */

/** 一个解析出来的标题节点。 */
export interface TexHeading {
  /** 1 = section，2 = subsection，3 = subsubsection。 */
  readonly level: 1 | 2 | 3
  readonly title: string
  /** 1 起的源码行号。 */
  readonly line: number
  readonly children: readonly TexHeading[]
}

/** 一次 section 移动：同名 section 落到"移除自己之后"的第 `targetIndex` 位。 */
export interface TexSectionMove {
  readonly title: string
  readonly targetIndex: number
}

/** 一次 subsection 移动：可跨 section。 */
export interface TexSubsectionMove {
  readonly sectionTitle: string
  readonly title: string
  readonly targetSectionTitle: string
  readonly targetIndex: number
}

/** 重排结果：成功给出新源码，失败给出可以直接展示的原因。 */
export type TexReorderOutcome =
  | { readonly ok: true; readonly tex: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

interface MutableHeading {
  readonly level: 1 | 2 | 3
  readonly title: string
  readonly line: number
  readonly children: MutableHeading[]
}

/** 从 `{` 起取一个平衡括号组（跳过转义字符）。 */
function braceGroup(text: string, open: number): string | undefined {
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

const COMMANDS = [
  { command: 'subsubsection', level: 3 },
  { command: 'subsection', level: 2 },
  { command: 'section', level: 1 },
] as const

/** 读一个标题命令（`start` 是反斜杠之后的下标）。 */
function headingAt(line: string, start: number): { level: 1 | 2 | 3; title: string } | undefined {
  for (const { command, level } of COMMANDS) {
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
    const title = braceGroup(line, cursor)
    if (title === undefined) return undefined
    return { level, title: title.trim() }
  }
  return undefined
}

function verbatimBoundary(line: string): 'open' | 'close' | undefined {
  if (/^\\begin\{verbatim\*?\}/.test(line)) return 'open'
  if (/^\\end\{verbatim\*?\}/.test(line)) return 'close'
  return undefined
}

/** 解析整份源码的标题树（顶层是 section）。 */
export function parseTexOutline(tex: string): TexHeading[] {
  const roots: MutableHeading[] = []
  const stack: MutableHeading[] = []
  let inVerbatim = false
  const lines = tex.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trimStart()
    const boundary = verbatimBoundary(trimmed)
    if (!inVerbatim && boundary === 'open') {
      inVerbatim = true
      continue
    }
    if (inVerbatim) {
      if (boundary === 'close') inVerbatim = false
      continue
    }
    if (trimmed.startsWith('%') || !trimmed.startsWith('\\')) continue
    const heading = headingAt(trimmed, 1)
    if (heading === undefined) continue
    const node: MutableHeading = { level: heading.level, title: heading.title, line: index + 1, children: [] }
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= node.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
    stack.push(node)
  }
  return roots.map(freezeHeading)
}

function freezeHeading(node: MutableHeading): TexHeading {
  return {
    level: node.level,
    title: node.title,
    line: node.line,
    children: node.children.map(freezeHeading),
  }
}

/** 顶层 section 标题，按文档顺序。 */
export function sectionTitles(tex: string): string[] {
  return parseTexOutline(tex).filter(node => node.level === 1).map(node => node.title)
}

/** 顶层 section 的 { 标题, 直接子标题 } 快照，用于拖拽基准的冲突判定。 */
export function sectionTreeTitles(tex: string): Array<{ title: string; subsections: string[] }> {
  return parseTexOutline(tex)
    .filter(node => node.level === 1)
    .map(node => ({ title: node.title, subsections: node.children.map(child => child.title) }))
}

function isDocumentEnd(line: string): boolean {
  return line.trimStart().startsWith('\\end{document}')
}

/** 最后一个 section 块到 `\end{document}` 之间属于"块尾"，重排不碰它。 */
function tailStartOf(lines: readonly string[], lastStart: number): number {
  for (let index = lastStart + 1; index < lines.length; index += 1) {
    if (isDocumentEnd(lines[index] ?? '')) return index
  }
  return lines.length
}

function conflict(code: string, message: string): TexReorderOutcome {
  return { ok: false, code, message }
}

/** 按 moves 重排顶层 section；moves 依次生效。 */
export function reorderSections(tex: string, moves: readonly TexSectionMove[]): TexReorderOutcome {
  const sections = parseTexOutline(tex).filter(node => node.level === 1)
  const firstMove = moves[0]
  if (sections.length === 0) {
    return firstMove === undefined
      ? { ok: true, tex }
      : conflict('section-not-found', `源码里没有 section：${firstMove.title}`)
  }
  const lines = tex.split('\n')
  const starts = sections.map(node => node.line - 1)
  const tailStart = tailStartOf(lines, starts[starts.length - 1] ?? 0)
  const blocks = sections.map((node, index) => ({
    title: node.title,
    lines: lines.slice(starts[index] ?? 0, index + 1 < starts.length ? starts[index + 1] ?? 0 : tailStart),
  }))
  const head = lines.slice(0, starts[0] ?? 0)
  const tail = lines.slice(tailStart)
  for (const move of moves) {
    const from = blocks.findIndex(block => block.title === move.title)
    if (from === -1) return conflict('section-not-found', `源码里找不到 section：${move.title}`)
    const [block] = blocks.splice(from, 1)
    if (block === undefined) return conflict('section-not-found', `源码里找不到 section：${move.title}`)
    if (!Number.isInteger(move.targetIndex) || move.targetIndex < 0 || move.targetIndex > blocks.length) {
      return conflict('invalid-move', `目标位置超出范围：${move.targetIndex}`)
    }
    blocks.splice(move.targetIndex, 0, block)
  }
  return { ok: true, tex: [...head, ...blocks.flatMap(block => block.lines), ...tail].join('\n') }
}

/** 按 moves 重排 subsection（可跨 section）；moves 依次生效。 */
export function reorderSubsections(tex: string, moves: readonly TexSubsectionMove[]): TexReorderOutcome {
  const sections = parseTexOutline(tex).filter(node => node.level === 1)
  const firstMove = moves[0]
  if (sections.length === 0) {
    return firstMove === undefined
      ? { ok: true, tex }
      : conflict('section-not-found', `源码里没有 section：${firstMove.sectionTitle}`)
  }
  const lines = tex.split('\n')
  const starts = sections.map(node => node.line - 1)
  const tailStart = tailStartOf(lines, starts[starts.length - 1] ?? 0)
  const blocks = sections.map((node, index) => {
    const start = starts[index] ?? 0
    const end = index + 1 < starts.length ? starts[index + 1] ?? 0 : tailStart
    const children = node.children
    return {
      title: node.title,
      head: lines.slice(start, children.length === 0 ? end : (children[0]?.line ?? 0) - 1),
      subs: children.map((child, childIndex) => ({
        title: child.title,
        lines: lines.slice(
          child.line - 1,
          childIndex + 1 < children.length ? (children[childIndex + 1]?.line ?? 0) - 1 : end,
        ),
      })),
    }
  })
  const head = lines.slice(0, starts[0] ?? 0)
  const tail = lines.slice(tailStart)
  for (const move of moves) {
    const source = blocks.find(block => block.title === move.sectionTitle)
    if (source === undefined) return conflict('section-not-found', `源码里找不到 section：${move.sectionTitle}`)
    const target = blocks.find(block => block.title === move.targetSectionTitle)
    if (target === undefined) return conflict('section-not-found', `源码里找不到目标 section：${move.targetSectionTitle}`)
    const from = source.subs.findIndex(sub => sub.title === move.title)
    if (from === -1) {
      return conflict('subsection-not-found', `${move.sectionTitle} 里找不到 subsection：${move.title}`)
    }
    // 同一个 section 内移动时，下标是"移除自己之后"的序号。
    const limit = source === target ? target.subs.length - 1 : target.subs.length
    if (!Number.isInteger(move.targetIndex) || move.targetIndex < 0 || move.targetIndex > limit) {
      return conflict('invalid-move', `目标位置超出范围：${move.targetIndex}`)
    }
    const [sub] = source.subs.splice(from, 1)
    if (sub === undefined) return conflict('subsection-not-found', `${move.sectionTitle} 里找不到 subsection：${move.title}`)
    target.subs.splice(move.targetIndex, 0, sub)
  }
  return {
    ok: true,
    tex: [...head, ...blocks.flatMap(block => [block.head, ...block.subs.map(sub => sub.lines)].flat()), ...tail].join('\n'),
  }
}
