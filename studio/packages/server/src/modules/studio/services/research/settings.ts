/**
 * Panel settings that belong to the machine, not to the wiki: the image-gen
 * endpoint/key and the SearXNG (sxng) knobs, plus the web search that reads
 * them.
 *
 * Both documents live next to the research store (`<research root>/`), are
 * written atomically, and never send a key back to the client: reads return a
 * masked preview only. A missing or malformed file reads as the documented
 * defaults, so the panel always has a form to show.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { researchRoot } from './store'

/* ------------------------------------------------------------- image gen */

export const IMAGE_GEN_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const IMAGE_GEN_DEFAULT_MODEL = 'gpt-image-1'
export const IMAGE_GEN_DEFAULT_SIZE = '1536x1024'

export interface ImageGenConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly size: string
}

export interface ImageGenConfigView {
  readonly configured: boolean
  readonly baseUrl: string
  readonly model: string
  readonly size: string
  readonly apiKeyPreview: string
}

/* ----------------------------------------------------------------- sxng */

export const SXNG_DEFAULT_BASE_URL = 'http://localhost:8080'
export const SXNG_DEFAULT_LIMIT = 10
export const SXNG_DEFAULT_TIMEOUT = 30_000
export const SXNG_DEFAULT_REDUNDANCY_THRESHOLD = 0.7
export const SXNG_DEFAULT_BIGRAM_THRESHOLD = 0.5

export interface SxngConfig {
  readonly baseUrl: string
  readonly defaultEngine: string
  readonly allowedEngines: readonly string[]
  readonly defaultLimit: number
  readonly defaultFormat: 'md' | 'json'
  readonly useProxy: boolean
  readonly proxyUrl: string
  readonly timeout: number
  readonly ollamaApiKey: string
  readonly redundancyThreshold: number
  readonly redundancyBigramThreshold: number
}

export interface SxngConfigView {
  readonly configured: boolean
  readonly baseUrl: string
  readonly defaultEngine: string
  readonly allowedEngines: readonly string[]
  readonly defaultLimit: number
  readonly defaultFormat: 'md' | 'json'
  readonly useProxy: boolean
  readonly proxyUrl: string
  readonly timeout: number
  readonly ollamaApiKeyPreview: string
  readonly redundancyThreshold: number
  readonly redundancyBigramThreshold: number
}

const IMAGE_GEN_FILE = 'image-gen.json'
const SXNG_FILE = 'sxng.json'

const IMAGE_GEN_DEFAULTS: ImageGenConfig = {
  baseUrl: IMAGE_GEN_DEFAULT_BASE_URL,
  apiKey: '',
  model: IMAGE_GEN_DEFAULT_MODEL,
  size: IMAGE_GEN_DEFAULT_SIZE,
}

const SXNG_DEFAULTS: SxngConfig = {
  baseUrl: SXNG_DEFAULT_BASE_URL,
  defaultEngine: '',
  allowedEngines: [],
  defaultLimit: SXNG_DEFAULT_LIMIT,
  defaultFormat: 'md',
  useProxy: false,
  proxyUrl: '',
  timeout: SXNG_DEFAULT_TIMEOUT,
  ollamaApiKey: '',
  redundancyThreshold: SXNG_DEFAULT_REDUNDANCY_THRESHOLD,
  redundancyBigramThreshold: SXNG_DEFAULT_BIGRAM_THRESHOLD,
}

/** `sk-abcdef…yz`: enough to recognize a key, not enough to use it. */
function maskKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 5)}…${key.slice(-2)}`
}

function settingsPath(profile: string | undefined, file: string): string {
  return path.join(researchRoot(profile), file)
}

/** Read one JSON document; anything unreadable reads as an empty object. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing or malformed: the caller falls back to its defaults.
  }
  return {}
}

/** Merge `next` over what is on disk and write it whole (tmp + rename). */
async function writeJson(file: string, next: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, file)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/* ------------------------------------------------------- image gen verbs */

async function readImageGen(profile?: string): Promise<ImageGenConfig> {
  const raw = await readJson(settingsPath(profile, IMAGE_GEN_FILE))
  return {
    baseUrl: stringOr(raw.baseUrl, '') || IMAGE_GEN_DEFAULTS.baseUrl,
    apiKey: stringOr(raw.apiKey, ''),
    model: stringOr(raw.model, '') || IMAGE_GEN_DEFAULTS.model,
    size: stringOr(raw.size, '') || IMAGE_GEN_DEFAULTS.size,
  }
}

function imageGenView(config: ImageGenConfig): ImageGenConfigView {
  return {
    configured: config.apiKey !== '',
    baseUrl: config.baseUrl,
    model: config.model,
    size: config.size,
    apiKeyPreview: maskKey(config.apiKey),
  }
}

export async function getImageGenConfig(profile?: string): Promise<ImageGenConfigView> {
  return imageGenView(await readImageGen(profile))
}

/**
 * Update the image-gen settings. An absent `apiKey` keeps the stored one (the
 * panel only round-trips the masked preview); an explicit `''` clears it.
 */
export async function setImageGenConfig(
  profile: string | undefined,
  request: { baseUrl?: string; apiKey?: string; model?: string; size?: string },
): Promise<ImageGenConfigView> {
  const current = await readImageGen(profile)
  const next: ImageGenConfig = {
    baseUrl: request.baseUrl?.trim() || current.baseUrl,
    apiKey: request.apiKey === undefined ? current.apiKey : request.apiKey.trim(),
    model: request.model?.trim() || current.model,
    size: request.size?.trim() || current.size,
  }
  if (!/^https?:\/\//.test(next.baseUrl)) throw new Error('image_gen_bad_base_url')
  await writeJson(settingsPath(profile, IMAGE_GEN_FILE), { ...next })
  return imageGenView(next)
}

/* ------------------------------------------------------------ sxng verbs */

async function readSxng(profile?: string): Promise<SxngConfig> {
  const parsed = await readJson(settingsPath(profile, SXNG_FILE))
  const engines = Array.isArray(parsed.allowedEngines)
    ? parsed.allowedEngines.filter((engine): engine is string => typeof engine === 'string')
    : []
  return {
    baseUrl: stringOr(parsed.baseUrl, SXNG_DEFAULTS.baseUrl),
    defaultEngine: stringOr(parsed.defaultEngine, SXNG_DEFAULTS.defaultEngine),
    allowedEngines: engines,
    defaultLimit: numberOr(parsed.defaultLimit, SXNG_DEFAULTS.defaultLimit),
    defaultFormat: parsed.defaultFormat === 'json' ? 'json' : 'md',
    useProxy: typeof parsed.useProxy === 'boolean' ? parsed.useProxy : SXNG_DEFAULTS.useProxy,
    proxyUrl: stringOr(parsed.proxyUrl, SXNG_DEFAULTS.proxyUrl),
    timeout: numberOr(parsed.timeout, SXNG_DEFAULTS.timeout),
    ollamaApiKey: stringOr(parsed.ollamaApiKey, SXNG_DEFAULTS.ollamaApiKey),
    redundancyThreshold: numberOr(parsed.redundancyThreshold, SXNG_DEFAULTS.redundancyThreshold),
    redundancyBigramThreshold: numberOr(parsed.redundancyBigramThreshold, SXNG_DEFAULTS.redundancyBigramThreshold),
  }
}

function sxngView(config: SxngConfig): SxngConfigView {
  return {
    configured: config.baseUrl !== '',
    baseUrl: config.baseUrl,
    defaultEngine: config.defaultEngine,
    allowedEngines: config.allowedEngines,
    defaultLimit: config.defaultLimit,
    defaultFormat: config.defaultFormat,
    useProxy: config.useProxy,
    proxyUrl: config.proxyUrl,
    timeout: config.timeout,
    ollamaApiKeyPreview: maskKey(config.ollamaApiKey),
    redundancyThreshold: config.redundancyThreshold,
    redundancyBigramThreshold: config.redundancyBigramThreshold,
  }
}

export async function getSxngConfig(profile?: string): Promise<SxngConfigView> {
  return sxngView(await readSxng(profile))
}

export async function setSxngConfig(
  profile: string | undefined,
  request: {
    baseUrl?: string
    defaultEngine?: string
    allowedEngines?: readonly string[]
    defaultLimit?: number
    defaultFormat?: 'md' | 'json'
    useProxy?: boolean
    proxyUrl?: string
    timeout?: number
    ollamaApiKey?: string
    redundancyThreshold?: number
    redundancyBigramThreshold?: number
  },
): Promise<SxngConfigView> {
  const current = await readSxng(profile)
  const next: SxngConfig = {
    baseUrl: request.baseUrl?.trim() || current.baseUrl,
    defaultEngine: request.defaultEngine?.trim() ?? current.defaultEngine,
    allowedEngines: request.allowedEngines?.map(engine => engine.trim()).filter(Boolean) ?? current.allowedEngines,
    defaultLimit: request.defaultLimit ?? current.defaultLimit,
    defaultFormat: request.defaultFormat ?? current.defaultFormat,
    useProxy: request.useProxy ?? current.useProxy,
    proxyUrl: request.proxyUrl?.trim() ?? current.proxyUrl,
    timeout: request.timeout ?? current.timeout,
    ollamaApiKey: request.ollamaApiKey === undefined ? current.ollamaApiKey : request.ollamaApiKey.trim(),
    redundancyThreshold: request.redundancyThreshold ?? current.redundancyThreshold,
    redundancyBigramThreshold: request.redundancyBigramThreshold ?? current.redundancyBigramThreshold,
  }
  if (!/^https?:\/\//.test(next.baseUrl)) throw new Error('sxng_bad_base_url')
  if (next.proxyUrl !== '' && !/^https?:\/\//.test(next.proxyUrl)) throw new Error('sxng_bad_proxy_url')
  if (!Number.isInteger(next.defaultLimit) || next.defaultLimit < 1) throw new Error('sxng_bad_limit')
  if (!Number.isInteger(next.timeout) || next.timeout < 1000) throw new Error('sxng_bad_timeout')
  const ratio = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1
  if (!ratio(next.redundancyThreshold) || !ratio(next.redundancyBigramThreshold)) {
    throw new Error('sxng_bad_threshold')
  }
  await writeJson(settingsPath(profile, SXNG_FILE), { ...next })
  return sxngView(next)
}

/* ------------------------------------------------------------ web search */

/** One SearXNG result row, in the shape the panel's literature search shows. */
export interface WebSearchEntry {
  readonly title: string
  readonly url: string
  readonly content: string
  readonly engine: string
  readonly category: string
  readonly publishedDate: string
}

/** Hard cap on one panel search (the engine's own cap is usually 10-20). */
const WEB_SEARCH_MAX = 50
/** One search request's timeout. */
const WEB_SEARCH_TIMEOUT_MS = 20_000

function searchEntry(raw: unknown): WebSearchEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const url = typeof row.url === 'string' ? row.url : ''
  if (url === '') return undefined
  const engines = Array.isArray(row.engines) ? row.engines.filter((item): item is string => typeof item === 'string') : []
  const single = typeof row.engine === 'string' ? row.engine : ''
  return {
    title: typeof row.title === 'string' ? row.title : url,
    url,
    content: typeof row.content === 'string' ? row.content : '',
    engine: single !== '' ? single : (engines[0] ?? ''),
    category: typeof row.category === 'string' ? row.category : '',
    publishedDate: typeof row.publishedDate === 'string' ? row.publishedDate : '',
  }
}

/**
 * Search the configured SearXNG instance (`/search?format=json`).
 *
 * `baseUrl` comes from the sxng settings, so an unconfigured machine fails
 * with `sxng_unconfigured` instead of silently returning nothing. Results are
 * mapped to the panel's row shape; a non-JSON answer (an instance with the
 * JSON format disabled) reports `sxng_bad_response`.
 */
export async function searchWeb(
  profile: string | undefined,
  request: { query: string; maxResults?: number; categories?: string; lang?: string },
): Promise<WebSearchEntry[]> {
  const query = request.query.trim()
  if (query === '') throw new Error('web_query_empty')
  const config = await readSxng(profile)
  if (config.baseUrl.trim() === '') throw new Error('sxng_unconfigured')
  const limit = request.maxResults ?? config.defaultLimit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WEB_SEARCH_MAX) throw new Error('web_bad_limit')

  const params = new URLSearchParams({ q: query, format: 'json' })
  if (request.categories !== undefined && request.categories.trim() !== '') {
    params.set('categories', request.categories.trim())
  }
  if (request.lang !== undefined && request.lang.trim() !== '') params.set('language', request.lang.trim())
  const url = `${config.baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`

  /** One request against the instance, mapped to the panel's row shape. */
  const fetchPage = async (): Promise<WebSearchEntry[]> => {
    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // 带上实例地址：面板只显示这一句话，没有地址就不知道该去改哪里。
      throw new Error(`sxng_unreachable: ${config.baseUrl.replace(/\/+$/, '')}（${reason}）`)
    }
    if (!response.ok) throw new Error(`sxng_http_${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('sxng_bad_response')
    }
    const results = (body as { results?: unknown })?.results
    if (!Array.isArray(results)) throw new Error('sxng_bad_response')
    return results.flatMap(raw => {
      const entry = searchEntry(raw)
      return entry === undefined ? [] : [entry]
    })
  }

  // 空页不等于"真的没有结果"：实例刚重启（bing 重启后的第一次查询尤其如此）
  // 会回 200 + 0 条，`unresponsive_engines` 还是空的。重试一次只是多一个请求，
  // 但能消掉面板上"搜过了却一片空白"的死角。
  let entries = await fetchPage()
  if (entries.length === 0) entries = await fetchPage()
  return entries.slice(0, limit)
}
