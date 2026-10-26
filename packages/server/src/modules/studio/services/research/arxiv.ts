/**
 * arXiv retrieval.
 *
 * Uses the public Atom API (no key, no scraping). Parsing is deliberately small:
 * the response shape has been stable for years and a dependency-free reader is
 * easier to reason about than an XML library for six fields.
 *
 * Failures are returned as data (`error`), never thrown: an offline box must
 * still render the panel's cached entries instead of a 500.
 */
const ENDPOINT = 'https://export.arxiv.org/api/query'
const TIMEOUT_MS = 20_000

export interface ArxivEntry {
  arxivId: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  summary: string
  published: string
}

export interface ArxivSearchResult {
  entries: ArxivEntry[]
  query: string
  error: string
  tookMs: number
}

function decode(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return match ? decode(match[1]) : ''
}

function allTags(block: string, name: string): string[] {
  const out: string[] = []
  const pattern = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) out.push(decode(match[1]))
  return out
}

/** `http://arxiv.org/abs/2401.01234v2` → `2401.01234`. */
function normalizeArxivId(rawId: string): string {
  const tail = rawId.split('/abs/').pop() || rawId
  return tail.replace(/v\d+$/, '').trim()
}

export function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = []
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || []
  for (const block of blocks) {
    const arxivId = normalizeArxivId(tag(block, 'id'))
    const title = tag(block, 'title')
    if (!arxivId || !title) continue
    const published = tag(block, 'published')
    entries.push({
      arxivId,
      title,
      authors: allTags(block, 'name').join(', '),
      year: published.slice(0, 4),
      venue: tag(block, 'arxiv:journal_ref') || 'arXiv',
      doi: tag(block, 'arxiv:doi'),
      url: `https://arxiv.org/abs/${arxivId}`,
      summary: tag(block, 'summary'),
      published,
    })
  }
  return entries
}

export async function searchArxiv(query: string, maxResults = 10): Promise<ArxivSearchResult> {
  const started = Date.now()
  const trimmed = query.trim()
  if (!trimmed) {
    return { entries: [], query: trimmed, error: '缺少检索词', tookMs: 0 }
  }
  const max = Math.min(Math.max(Math.trunc(maxResults) || 10, 1), 40)
  const url = `${ENDPOINT}?search_query=all:${encodeURIComponent(trimmed)}&start=0&max_results=${max}`
    + '&sortBy=relevance&sortOrder=descending'

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ekko-research/1.0 (+local)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      return {
        entries: [],
        query: trimmed,
        error: `arXiv 返回 HTTP ${response.status}`,
        tookMs: Date.now() - started,
      }
    }
    const xml = await response.text()
    return { entries: parseArxivFeed(xml), query: trimmed, error: '', tookMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      entries: [],
      query: trimmed,
      error: /timeout|aborted/i.test(message) ? 'arXiv 请求超时' : `arXiv 请求失败：${message}`,
      tookMs: Date.now() - started,
    }
  }
}
