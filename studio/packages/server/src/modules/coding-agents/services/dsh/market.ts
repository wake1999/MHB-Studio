import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DshPluginError } from './errors'
import { dshInstallSpec } from './plugins'

/**
 * The community index behind the DSH plugin market. The source profile keeps no
 * copy of it (the market plugin resolves the same document at runtime), so the
 * live document is authoritative and an installed market's cached snapshot is
 * only a fallback for a host that cannot reach the network.
 */
const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const FETCH_TIMEOUT_MS = 15_000
const CACHE_MS = 10 * 60_000
const DESCRIPTION_LIMIT = 600
const MAX_LIMIT = 120
const DEFAULT_LIMIT = 60

interface MarketItem {
  name?: unknown
  owner?: unknown
  url?: unknown
  page?: unknown
  category?: unknown
  description?: unknown
  npm?: unknown
  version?: unknown
  stars?: unknown
  downloads?: unknown
  capabilities?: unknown
  install?: unknown
  added?: unknown
}

interface MarketDocument {
  updated?: unknown
  categories?: unknown
  plugins?: unknown
}

export interface DshMarketCategory { id: string; en: string; zh: string }

export interface DshMarketEntry {
  id: string
  name: string
  owner: string
  category: string
  descriptionEn: string
  descriptionZh: string
  npm: string
  version: string
  stars: number
  downloads: number
  capabilities: string[]
  install: string
  spec: string
  installable: boolean
  page: string
  url: string
  added: string
}

export interface DshPluginMarketPage {
  source: 'live' | 'snapshot'
  updated: string
  fetchedAt: string
  stale: boolean
  total: number
  matched: number
  categories: DshMarketCategory[]
  entries: DshMarketEntry[]
}

export interface DshPluginMarketQuery {
  q?: string
  category?: string
  sort?: string
  limit?: number
  offset?: number
  refresh?: boolean
}

interface DshMarketRegistry {
  source: 'live' | 'snapshot'
  updated: string
  categories: DshMarketCategory[]
  entries: DshMarketEntry[]
}

let cache: { at: number; registry: DshMarketRegistry } | undefined

function text(value: unknown, limit = 0): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return limit > 0 && trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function localized(value: unknown, key: 'en' | 'zh'): string {
  if (typeof value === 'string') return text(value, DESCRIPTION_LIMIT)
  if (value === null || typeof value !== 'object') return ''
  return text((value as Record<string, unknown>)[key], DESCRIPTION_LIMIT)
}

function capabilities(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 12) : []
}

/** `dsh plugin --profile web add <spec>` is the index's own install line. */
function installSpec(install: string): string {
  const parts = install.split(/\s+/).filter(Boolean)
  if (parts.length < 4 || parts[0] !== 'dsh' || parts[1] !== 'plugin' || parts[parts.length - 2] !== 'add') return ''
  return dshInstallSpec(parts[parts.length - 1]) || ''
}

function entry(item: MarketItem, index: number): DshMarketEntry | undefined {
  const name = text(item.name, 120)
  const owner = text(item.owner, 120)
  if (name === '' || owner === '') return undefined
  const install = text(item.install, 512)
  const spec = installSpec(install)
  return {
    id: `${owner}/${name}#${String(index)}`,
    name,
    owner,
    category: text(item.category, 40),
    descriptionEn: localized(item.description, 'en'),
    descriptionZh: localized(item.description, 'zh'),
    npm: text(item.npm, 200),
    version: text(item.version, 60),
    stars: count(item.stars),
    downloads: count(item.downloads),
    capabilities: capabilities(item.capabilities),
    install,
    spec,
    installable: spec !== '',
    page: text(item.page, 500),
    url: text(item.url, 500),
    added: text(item.added, 40),
  }
}

function categories(value: unknown): DshMarketCategory[] {
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([id, label]) => {
    if (label === null || typeof label !== 'object') return []
    const record = label as Record<string, unknown>
    const en = text(record.en, 120)
    const zh = text(record.zh, 120)
    return en === '' && zh === '' ? [] : [{ id, en, zh }]
  }).sort((left, right) => left.id.localeCompare(right.id))
}

function parse(content: string, source: 'live' | 'snapshot'): DshMarketRegistry {
  const document = JSON.parse(content) as MarketDocument
  if (!Array.isArray(document.plugins)) throw new Error('market index has no plugin list')
  return {
    source,
    updated: text(document.updated, 40),
    categories: categories(document.categories),
    entries: document.plugins.flatMap((item, index) => {
      const normalized = entry(item as MarketItem, index)
      return normalized === undefined ? [] : [normalized]
    }),
  }
}

async function readSnapshot(sourceHome: string): Promise<DshMarketRegistry> {
  const path = join(sourceHome, 'profiles', 'web', 'node_modules', 'dshmarket', 'data', 'registry-snapshot.json')
  return parse(await readFile(path, 'utf8'), 'snapshot')
}

async function readRegistry(sourceHome: string, refresh: boolean): Promise<DshMarketRegistry> {
  if (!refresh && cache !== undefined && Date.now() - cache.at < CACHE_MS) return cache.registry
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json', 'user-agent': 'ekko-studio' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`market index answered HTTP ${String(response.status)}`)
    const registry = parse(await response.text(), 'live')
    cache = { at: Date.now(), registry }
    return registry
  } catch (liveError) {
    // A reachable host keeps serving the last good document; an offline one falls
    // back to whatever the market plugin cached into the profile.
    const snapshot = await readSnapshot(sourceHome).catch(() => undefined)
    if (snapshot !== undefined) {
      cache = { at: Date.now(), registry: snapshot }
      return snapshot
    }
    if (cache !== undefined) return cache.registry
    throw new DshPluginError(503, 'DSH_MARKET_UNAVAILABLE', 'Unable to read the plugin market index')
  }
}

/** Ordered to answer "what should I install" first without a second request. */
function order(left: DshMarketEntry, right: DshMarketEntry, sort: string): number {
  if (sort === 'new') return right.added.localeCompare(left.added) || left.name.localeCompare(right.name)
  if (sort === 'name') return left.name.localeCompare(right.name)
  return right.downloads - left.downloads || right.stars - left.stars || left.name.localeCompare(right.name)
}

function matches(entry: DshMarketEntry, query: string, category: string): boolean {
  if (category !== '' && entry.category !== category) return false
  if (query === '') return true
  return [entry.name, entry.owner, entry.npm, entry.category, entry.descriptionEn, entry.descriptionZh]
    .some(value => value.toLowerCase().includes(query))
}

/** One page of the index, filtered and ordered for the market page. */
export async function queryDshPluginMarket(input: DshPluginMarketQuery & { sourceHome: string }): Promise<DshPluginMarketPage> {
  const registry = await readRegistry(input.sourceHome, input.refresh === true)
  const query = (input.q || '').trim().toLowerCase().slice(0, 120)
  const wanted = registry.categories.some(item => item.id === input.category) ? input.category! : ''
  const filtered = registry.entries.filter(item => matches(item, query, wanted)).sort((left, right) => order(left, right, input.sort || 'hot'))
  const limit = Math.min(Math.max(Number.isFinite(input.limit) ? Number(input.limit) : DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(Number.isFinite(input.offset) ? Number(input.offset) : 0, 0)
  return {
    source: registry.source,
    updated: registry.updated,
    fetchedAt: new Date().toISOString(),
    stale: registry.source === 'snapshot',
    total: registry.entries.length,
    matched: filtered.length,
    categories: registry.categories,
    entries: filtered.slice(offset, offset + limit),
  }
}
