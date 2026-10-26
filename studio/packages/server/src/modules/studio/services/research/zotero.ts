/**
 * Zotero bridge: the read-only API client behind the literature view.
 *
 * Credentials live outside the store (never in state.json, never in a log):
 *   - env  ZOTERO_API_KEY / ZOTERO_USER_ID
 *   - file <research root>/zotero.json  { "apiKey": "...", "userId": "..." }
 * Nothing here ever echoes the key back: callers only see parsed records or a
 * failure message.
 *
 * Scope is one user library (group libraries are out of scope) and reads only:
 * the probe, the collection list, a full-text item search, one item read, a
 * BibTeX export, plus the two writes the panel performs on the research store
 * (import one item into a project's papers, merge a collection into
 * `references.bib`).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { parseBibtex } from './bibtex'
import { appendBibliographyEntries } from './paper'
import { newId, readStore, researchRoot, updateStore } from './store'

/** Timeout of one Zotero API probe. */
const PROBE_TIMEOUT_MS = 8_000
/** Timeout of one request made on the panel's behalf (a search may be slower). */
const REQUEST_TIMEOUT_MS = 15_000
/** Default result cap of one panel-driven search. */
const SEARCH_DEFAULT_MAX = 10
/** Hard result cap of one panel-driven search. */
const SEARCH_HARD_MAX = 50
/** Page size of a collection BibTeX export (the API caps export formats at 150). */
const BIB_PAGE_LIMIT = 100
/** Safety bound on the export pagination loop. */
const BIB_MAX_PAGES = 50
/** Default wait before the single rate-limit retry. */
const RETRY_DEFAULT_MS = 1_000
/** Cap of the rate-limit wait. */
const RETRY_MAX_MS = 10_000
const API_BASE = 'https://api.zotero.org'

export interface ZoteroConfig {
  readonly apiKey: string
  readonly userId: string
}

export interface ZoteroStatus {
  readonly state: 'unconfigured' | 'ok' | 'failed'
  readonly message?: string
}

/** One collection as the export picker lists it. */
export interface ZoteroCollection {
  readonly key: string
  readonly name: string
  readonly itemCount: number
}

/** One reference item reduced to the fields the workbench shows. */
export interface ZoteroItem {
  readonly key: string
  readonly title: string
  readonly authors: string[]
  readonly year: string
  readonly doi: string
  readonly arxivId: string | null
  readonly publicationTitle: string
  readonly url: string
}

function configPath(profile?: string): string {
  return path.join(researchRoot(profile), 'zotero.json')
}

/** Resolve credentials: env first, then the JSON file. Malformed files read as absent. */
export async function readZoteroConfig(profile?: string): Promise<ZoteroConfig | null> {
  const envKey = (process.env.ZOTERO_API_KEY || '').trim()
  const envUser = (process.env.ZOTERO_USER_ID || '').trim()
  if (envKey !== '' && envUser !== '') return { apiKey: envKey, userId: envUser }

  try {
    const raw = await fs.readFile(configPath(profile), 'utf-8')
    const parsed = JSON.parse(raw) as { apiKey?: unknown; userId?: unknown }
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : ''
    const userId = typeof parsed.userId === 'string' ? String(parsed.userId).trim() : ''
    if (apiKey === '' || userId === '') return null
    return { apiKey, userId }
  } catch {
    return null
  }
}

/**
 * Probe the configured library with one cheap request.
 * @param profile - the research profile whose config file applies.
 * @returns `unconfigured` when no credentials exist, `ok` when the API accepts
 * them, `failed` (with the reason) otherwise. Never throws.
 */
export async function probeZotero(profile?: string): Promise<ZoteroStatus> {
  const config = await readZoteroConfig(profile)
  if (config === null) return { state: 'unconfigured' }

  const url = `${API_BASE}/users/${encodeURIComponent(config.userId)}/items?limit=1`
  try {
    const response = await fetch(url, {
      headers: { 'Zotero-API-Key': config.apiKey, 'Zotero-API-Version': '3' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.ok) return { state: 'ok' }
    if (response.status === 403 || response.status === 401) {
      return { state: 'failed', message: `Zotero 拒绝了这组凭据（HTTP ${response.status}），请确认 apiKey 与 userId 匹配` }
    }
    if (response.status === 404) {
      return { state: 'failed', message: `Zotero 上找不到 userId=${config.userId} 的文献库（HTTP 404）` }
    }
    return { state: 'failed', message: `Zotero 返回 HTTP ${response.status}` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { state: 'failed', message: `连不上 Zotero API：${reason}` }
  }
}

/* ------------------------------------------------------------- the client */

/** Wait `ms`; the caller already bounded this by the request timeout. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Milliseconds to wait before the retry, from `Retry-After`. */
function retryDelayMs(response: Response): number {
  const header = response.headers.get('retry-after')
  if (header === null || header.trim() === '') return RETRY_DEFAULT_MS
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, RETRY_MAX_MS) : RETRY_DEFAULT_MS
}

/**
 * One authenticated GET. A 429/503 is retried exactly once after its
 * `Retry-After`; every non-OK status then throws with status and URL (never
 * the key).
 */
async function call(config: ZoteroConfig, url: string): Promise<Response> {
  const init: RequestInit = {
    headers: { 'Zotero-API-Key': config.apiKey, 'Zotero-API-Version': '3' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }
  let response = await fetch(url, init)
  if (response.status === 429 || response.status === 503) {
    await sleep(retryDelayMs(response))
    response = await fetch(url, init)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.replace(API_BASE, '')}`)
  return response
}

function configOf(config: ZoteroConfig | null): ZoteroConfig {
  if (config === null) throw new Error('zotero_unconfigured')
  return config
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  return typeof value === 'string' ? value : ''
}

/** Recover a bare arXiv id from one item's `extra` field or URL, or null. */
function extractArxivId(extra: string, url: string): string | null {
  const candidates = [
    /arxiv:\s*([^\s\]]+)/i.exec(extra)?.[1],
    /arxiv\.org\/abs\/([^\s/?#]+)/i.exec(url)?.[1],
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const id = candidate.trim()
    if (/^[a-zA-Z0-9._/-]+$/.test(id)) return id
  }
  return null
}

/** Reduce one raw API item; undefined for child items (attachments, notes). */
function parseItem(raw: unknown): ZoteroItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const envelope = raw as Record<string, unknown>
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return undefined
  const fields = data as Record<string, unknown>
  const itemType = stringField(fields, 'itemType')
  if (itemType === 'attachment' || itemType === 'note') return undefined
  const key = stringField(envelope, 'key')
  if (key === '') return undefined
  const creators = Array.isArray(fields.creators) ? fields.creators : []
  const authors = creators.flatMap((creator): string[] => {
    if (typeof creator !== 'object' || creator === null) return []
    const record = creator as Record<string, unknown>
    const single = stringField(record, 'name')
    if (single !== '') return [single]
    const name = `${stringField(record, 'firstName')} ${stringField(record, 'lastName')}`.trim()
    return name === '' ? [] : [name]
  })
  const year = /\d{4}/.exec(stringField(fields, 'date'))?.[0] ?? ''
  const doi = stringField(fields, 'DOI')
  const itemUrl = stringField(fields, 'url')
  return {
    key,
    title: stringField(fields, 'title'),
    authors,
    year,
    doi,
    arxivId: extractArxivId(stringField(fields, 'extra'), itemUrl),
    publicationTitle: stringField(fields, 'publicationTitle'),
    url: itemUrl !== '' ? itemUrl : doi === '' ? '' : `https://doi.org/${doi}`,
  }
}

function parseItems(body: string): ZoteroItem[] {
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(raw => {
    const item = parseItem(raw)
    return item === undefined ? [] : [item]
  })
}

function parseCollections(body: string): ZoteroCollection[] {
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed)) return []
  const out: ZoteroCollection[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    const envelope = raw as Record<string, unknown>
    const data = envelope.data
    if (typeof data !== 'object' || data === null) continue
    const key = stringField(envelope, 'key')
    const name = stringField(data as Record<string, unknown>, 'name')
    if (key === '') continue
    const meta = envelope.meta
    const numItems = typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>).numItems
      : undefined
    out.push({ key, name, itemCount: typeof numItems === 'number' ? numItems : 0 })
  }
  return out
}

function userBase(config: ZoteroConfig): string {
  return `${API_BASE}/users/${encodeURIComponent(config.userId)}`
}

/* ------------------------------------------------------------- the reads */

/** Every collection of the configured library. Throws `zotero_unconfigured`. */
export async function listZoteroCollections(profile?: string): Promise<ZoteroCollection[]> {
  const config = configOf(await readZoteroConfig(profile))
  const response = await call(config, `${userBase(config)}/collections?limit=100`)
  return parseCollections(await response.text())
}

/** Full-text item search (`qmode=everything`). Throws `zotero_unconfigured`. */
export async function searchZoteroItems(
  profile: string | undefined,
  query: string,
  maxResults?: number,
): Promise<ZoteroItem[]> {
  const config = configOf(await readZoteroConfig(profile))
  const trimmed = query.trim()
  if (trimmed === '') throw new Error('zotero_query_empty')
  const limit = maxResults ?? SEARCH_DEFAULT_MAX
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_HARD_MAX) throw new Error('zotero_bad_limit')
  const url = `${userBase(config)}/items?q=${encodeURIComponent(trimmed)}&qmode=everything&limit=${String(limit)}`
  return parseItems(await (await call(config, url)).text())
}

/** Read one item by key. Throws `zotero_unconfigured` / `zotero_item_not_reference`. */
export async function fetchZoteroItem(profile: string | undefined, key: string): Promise<ZoteroItem> {
  const config = configOf(await readZoteroConfig(profile))
  const body = await (await call(config, `${userBase(config)}/items/${encodeURIComponent(key)}`)).text()
  const [item] = parseItems(`[${body}]`)
  if (item === undefined) throw new Error('zotero_item_not_reference')
  return item
}

/** Export one collection as BibTeX text (paginated). Throws `zotero_unconfigured`. */
export async function exportZoteroCollectionBibtex(
  profile: string | undefined,
  collectionKey: string,
): Promise<string> {
  const config = configOf(await readZoteroConfig(profile))
  const collection = encodeURIComponent(collectionKey)
  const chunks: string[] = []
  let start = 0
  for (let page = 0; page < BIB_MAX_PAGES; page += 1) {
    const url = `${userBase(config)}/collections/${collection}/items?format=bibtex`
      + `&limit=${String(BIB_PAGE_LIMIT)}&start=${String(start)}`
    const response = await call(config, url)
    const text = await response.text()
    if (text.trim() === '') break
    chunks.push(text)
    const total = Number(response.headers.get('total-results'))
    start += BIB_PAGE_LIMIT
    if (!Number.isFinite(total) || start >= total) break
  }
  return chunks.join('\n')
}

/* ------------------------------------------------------------- the writes */

export interface ZoteroImportResult {
  /** 这次是不是新导入（同名论文已存在时为 false，只刷新元数据）。 */
  imported: boolean
  /** papers 表里的键：裸 arXiv id，或 `zotero-<item key>`。 */
  paperId: string
}

/**
 * Import one Zotero item into a project's papers table.
 *
 * ekko's papers are project-scoped, so an import always lands in a project
 * (the caller resolves it). A re-import refreshes title/authors/venue/doi and
 * keeps the workbench-curated `notes` unless the stored notes are empty.
 */
export async function importZoteroItem(
  profile: string | undefined,
  key: string,
  projectId: string,
): Promise<ZoteroImportResult> {
  const trimmed = key.trim()
  if (trimmed === '') throw new Error('zotero_key_empty')
  const item = await fetchZoteroItem(profile, trimmed)
  if (item.title.trim() === '') throw new Error('zotero_item_no_title')
  const paperKey = item.arxivId !== null ? item.arxivId : `zotero-${trimmed}`

  const outcome = await updateStore(profile, 'papers.imported', store => {
    if (!store.projects.some(project => project.id === projectId)) return null
    const existing = store.papers.find(paper => paper.projectId === projectId
      && (paper.arxivId === paperKey || paper.id === paperKey))
    if (existing) {
      existing.title = item.title
      existing.authors = item.authors.join(', ')
      existing.year = item.year
      existing.venue = item.publicationTitle || existing.venue
      existing.doi = item.doi
      existing.url = item.url || existing.url
      existing.arxivId = paperKey
      if (existing.notes.trim() === '') existing.notes = zoteroProvenance(item)
      return { imported: false, paperId: paperKey }
    }
    store.papers.unshift({
      id: newId('paper'),
      projectId,
      title: item.title,
      authors: item.authors.join(', '),
      year: item.year,
      venue: item.publicationTitle || 'Zotero',
      doi: item.doi,
      url: item.url,
      arxivId: paperKey,
      score: 0,
      status: 'new',
      notes: zoteroProvenance(item),
      addedAt: Date.now(),
    })
    return { imported: true, paperId: paperKey }
  })
  if (outcome === null) throw new Error('project_not_found')
  return outcome
}

/** The provenance line an imported item carries in its notes. */
function zoteroProvenance(item: ZoteroItem): string {
  return [
    `从 Zotero 导入（item ${item.key}）。`,
    item.doi === '' ? '' : `DOI: ${item.doi}。`,
    item.url === '' ? '' : `URL: ${item.url}。`,
  ].filter(line => line !== '').join(' ')
}

export interface ZoteroBibExportResult {
  added: string[]
  skipped: string[]
}

/** Merge one collection's BibTeX into the project's `references.bib`. */
export async function exportZoteroCollectionToBib(
  profile: string | undefined,
  projectId: string,
  collectionKey: string,
): Promise<ZoteroBibExportResult> {
  const key = collectionKey.trim()
  if (key === '') throw new Error('zotero_collection_empty')
  const store = await readStore(profile)
  if (!store.projects.some(project => project.id === projectId)) throw new Error('project_not_found')
  const bibtex = await exportZoteroCollectionBibtex(profile, key)
  const entries = parseBibtex(bibtex)
  return appendBibliographyEntries(projectId, entries, profile)
}
