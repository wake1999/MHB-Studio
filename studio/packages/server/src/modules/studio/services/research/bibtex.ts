/**
 * BibTeX 解析 / 序列化：无依赖纯函数，不碰文件系统。
 *
 * 移植自上游 ui-mimir 的 `packages/mimir/src/bibtex.ts`，保留同样的容错子集：
 * 任意 `@type` 都收（article / inproceedings / misc / book …），字段名小写，
 * `{braced}`（嵌套感知）与 `"quoted"` 两种值语法都读，裸 token（数字、month 宏）
 * 原样保留，`@string` / `@preamble` / `@comment` 跳过，坏块跳过而不是让整个文件失败。
 * 序列化一律写花括号值，`parse(serialize(x))` 与 `x` 深相等（round-trip 不变式）。
 */

/** 一条解析后的 BibTeX 条目。 */
export interface BibEntry {
  /** 引用键（`\cite{key}`）。 */
  readonly key: string
  /** 小写条目类型（`article`、`inproceedings`、`misc` …）。 */
  readonly type: string
  /** 小写字段名 → 原始值（花括号/引号已剥离）。 */
  readonly fields: Record<string, string>
}

/** 正文不是文献条目的类型，解析时跳过。 */
const SKIPPED_TYPES = new Set(['string', 'preamble', 'comment'])

/**
 * 从 `start`（`=` 之后第一个非空白字符）读一个字段值：花括号组（嵌套感知）、
 * 引号串（识别 `\"` 转义）或到 `,`/`}`/`)` 为止的裸 token。
 */
function readValue(text: string, start: number): { value: string; end: number } | undefined {
  const opener = text.charAt(start)
  if (opener === '{') {
    let depth = 1
    let index = start + 1
    while (index < text.length && depth > 0) {
      const char = text.charAt(index)
      if (char === '\\') index += 1 // 被转义的字符不会改变嵌套层数
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    if (depth !== 0) return undefined
    return { value: text.slice(start + 1, index - 1), end: index }
  }
  if (opener === '"') {
    let index = start + 1
    while (index < text.length) {
      const char = text.charAt(index)
      if (char === '\\') index += 2
      else if (char === '"') return { value: text.slice(start + 1, index), end: index + 1 }
      else index += 1
    }
    return undefined
  }
  // 裸 token：数字、month 宏、字符串引用。
  const match = /^[^,})\s]+/.exec(text.slice(start))
  if (match === null) return undefined
  const token = match[0]
  return { value: token, end: start + token.length }
}

/**
 * 从 `at`（`@` 的位置）读一个 `@type{…}` / `@type(…)` 块。
 * 返回条目（`@string` 等为 undefined）与块结束后的下标；坏块返回 undefined，
 * 调用方跳过该 `@` 继续找下一个。
 */
function readEntry(text: string, at: number): { entry: BibEntry | undefined; end: number } | undefined {
  const head = /^@([a-zA-Z]+)\s*([{(])\s*/.exec(text.slice(at))
  if (head === null) return undefined
  const type = head[1].toLowerCase()
  const closer = head[2] === '{' ? '}' : ')'
  let index = at + head[0].length
  if (SKIPPED_TYPES.has(type)) {
    // 跳到配对的收尾符；@comment 可以没有 key。
    let depth = 1
    while (index < text.length && depth > 0) {
      const char = text.charAt(index)
      if (char === '\\') index += 1
      else if (char === '{' || char === '(') depth += 1
      else if (char === '}' || char === ')') depth -= 1
      index += 1
    }
    return { entry: undefined, end: index }
  }
  const keyMatch = /^[^,\s})]+/.exec(text.slice(index))
  if (keyMatch === null) return undefined
  const key = keyMatch[0]
  index += key.length
  const fields: Record<string, string> = {}
  let closed = false
  while (index < text.length) {
    // 跳过空白、逗号与条目内注释（`%` 到行尾）。
    const skip = /^(?:\s|%[^\n]*|,)+/.exec(text.slice(index))
    if (skip !== null) index += skip[0].length
    const char = text.charAt(index)
    if (char === '') return undefined
    if (char === closer) {
      closed = true
      index += 1
      break
    }
    const nameMatch = /^[a-zA-Z][\w-]*\s*=\s*/.exec(text.slice(index))
    if (nameMatch === null) return undefined
    const name = nameMatch[0].replace(/[\s=]/g, '').toLowerCase()
    index += nameMatch[0].length
    const read = readValue(text, index)
    if (read === undefined) return undefined
    fields[name] = read.value
    index = read.end
    // 值后面可能跟 ` # 宏` 连接，再读一次拼上。
    const concat = /^\s*#\s*/.exec(text.slice(index))
    if (concat !== null) {
      const next = readValue(text, index + concat[0].length)
      if (next === undefined) return undefined
      fields[name] += next.value
      index = next.end
    }
  }
  if (!closed) return undefined
  return { entry: { key, type, fields }, end: index }
}

/**
 * 把 `.bib` 文本解析成条目列表（保持文件顺序）。
 * `@entry` 块之外的内容按 BibTeX 规则算注释丢弃；坏块跳过，不会拖垮整个文件。
 */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    const read = readEntry(text, at)
    if (read === undefined) {
      index = at + 1
      continue
    }
    if (read.entry !== undefined) entries.push(read.entry)
    index = Math.max(read.end, at + 1)
  }
  return entries
}

/**
 * 条目序列化回 `.bib` 文本：条目之间空一行，字段两空格缩进 + 花括号值 + 行尾逗号，
 * 文件末尾留一个换行。空字段的条目写成 `@type{key}`。
 */
export function serializeBibtex(entries: readonly BibEntry[]): string {
  const body = entries
    .map((entry) => {
      const rows = Object.entries(entry.fields)
        .map(([name, value]) => `  ${name} = {${value}},`)
        .join('\n')
      return rows === ''
        ? `@${entry.type}{${entry.key}}`
        : `@${entry.type}{${entry.key},\n${rows}\n}`
    })
    .join('\n\n')
  return entries.length > 0 ? `${body}\n` : ''
}

/** 一个 arXiv id 对应的合法引用键：点与 `v` 分隔符去掉。 */
export function bibKeyOf(arxivId: string): string {
  return arxivId.replace(/[^a-zA-Z0-9_-]/g, '')
}

/**
 * 真 arXiv id：新式 `YYMM.NNNNN(vN)` 或旧式 `archive/YYMMNNN(vN)`。
 * 比路径安全判定更严——`zotero-<item key>` 这类键路径安全但不是 arXiv 论文，
 * 投影时不能凭空给它一个 arXiv 身份。
 */
const ARXIV_ID_SHAPE = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?)$/

/** 投影所需的 paper 记录字段子集（ekko 侧是平铺字符串）。 */
export interface BibSourcePaper {
  readonly title: string
  readonly authors: string
  readonly year: string
  readonly url: string
  readonly doi: string
  readonly arxivId: string
}

/**
 * 把一条已收文献投影成 `@misc` 条目。
 *
 * 只取来源元数据：`year` 取记录自己的年份（不取入库时间）；只有带真 arXiv id 的
 * 才写 `eprint`/`archivePrefix`，`url` 缺省时才回落到 arXiv 摘要页；`doi` 只在
 * 来源给了才写；阅读笔记属于工作台内部信息，绝不进引用。
 *
 * 与上游的差异：ekko 的 `authors` 是逗号分隔的字符串（arXiv 抓取侧如此存），
 * 这里转成 BibTeX 要求的 ` and ` 分隔；已经带 ` and ` 的原样保留。
 */
export function entryFromPaper(paper: BibSourcePaper): BibEntry {
  const fields: Record<string, string> = {}
  const authors = paper.authors.trim()
  if (authors !== '') {
    fields.author = authors.includes(' and ')
      ? authors
      : authors.split(',').map(name => name.trim()).filter(name => name !== '').join(' and ')
  }
  fields.title = paper.title
  const year = /\d{4}/.exec(paper.year)
  if (year !== null) fields.year = year[0]
  if (ARXIV_ID_SHAPE.test(paper.arxivId)) {
    fields.eprint = paper.arxivId
    fields.archiveprefix = 'arXiv'
    fields.url = paper.url === '' ? `https://arxiv.org/abs/${paper.arxivId}` : paper.url
  } else if (paper.url !== '') {
    fields.url = paper.url
  }
  if (paper.doi !== '') fields.doi = paper.doi
  return { key: bibKeyOf(paper.arxivId), type: 'misc', fields }
}
