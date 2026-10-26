/**
 * Conference deadlines from ccfddl (the dataset behind ccf-deadlines).
 *
 * Fetched once every six hours and cached on disk; an offline box keeps serving
 * the cached catalogue and says so instead of failing the panel.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { researchRoot } from './store'

// js-yaml ships without types in this repo; keep the surface explicit.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (input: string) => unknown }

const SOURCE = 'https://ccfddl.github.io/conference/allconf.yml'
const TTL_MS = 6 * 60 * 60 * 1000
const TIMEOUT_MS = 30_000

export interface VenueDeadline {
  key: string
  name: string
  fullName: string
  ccf: string
  field: string
  deadline: string
  place: string
  link: string
  year: string
}

export interface VenueCatalog {
  items: VenueDeadline[]
  fetchedAt: number
  stale: boolean
  error: string
}

interface RawTimeline {
  deadline?: string
  comment?: string
}

interface RawConf {
  year?: number | string
  link?: string
  place?: string
  timeline?: RawTimeline[]
}

interface RawVenue {
  title?: string
  description?: string
  sub?: string
  rank?: { ccf?: string }
  confs?: RawConf[]
}

function cachePath(profile?: string): string {
  return path.join(researchRoot(profile), 'ccfddl.json')
}

function normalizeDate(value: string): string {
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

/** Latest timeline entry that has not passed; otherwise the newest one. */
function pickDeadline(confs: RawConf[] | undefined, now: number): { deadline: string; conf: RawConf | null } {
  let best = ''
  let bestConf: RawConf | null = null
  let fallback = ''
  let fallbackConf: RawConf | null = null
  for (const conf of confs || []) {
    for (const entry of conf.timeline || []) {
      const date = normalizeDate(String(entry.deadline || ''))
      if (!date) continue
      const time = new Date(`${date}T23:59:59`).getTime()
      if (!fallback || time > new Date(`${fallback}T23:59:59`).getTime()) {
        fallback = date
        fallbackConf = conf
      }
      if (time >= now && (!best || time < new Date(`${best}T23:59:59`).getTime())) {
        best = date
        bestConf = conf
      }
    }
  }
  return best ? { deadline: best, conf: bestConf } : { deadline: fallback, conf: fallbackConf }
}

function parseCatalog(text: string, now = Date.now()): VenueDeadline[] {
  const parsed = yaml.load(text)
  if (!Array.isArray(parsed)) return []
  const items: VenueDeadline[] = []
  for (const raw of parsed as RawVenue[]) {
    if (!raw || typeof raw !== 'object' || !raw.title) continue
    const { deadline, conf } = pickDeadline(raw.confs, now)
    if (!deadline) continue
    items.push({
      key: `${raw.title}-${conf?.year || ''}`,
      name: String(raw.title),
      fullName: String(raw.description || raw.title),
      ccf: String(raw.rank?.ccf || ''),
      field: String(raw.sub || ''),
      deadline,
      place: String(conf?.place || ''),
      link: String(conf?.link || ''),
      year: String(conf?.year || ''),
    })
  }
  items.sort((a, b) => a.deadline.localeCompare(b.deadline))
  return items
}

async function readCache(profile?: string): Promise<{ fetchedAt: number; items: VenueDeadline[] } | null> {
  try {
    const raw = await fs.readFile(cachePath(profile), 'utf-8')
    const parsed = JSON.parse(raw) as { fetchedAt?: number; items?: VenueDeadline[] }
    if (!Array.isArray(parsed.items)) return null
    return { fetchedAt: Number(parsed.fetchedAt || 0), items: parsed.items }
  } catch {
    return null
  }
}

async function writeCache(profile: string | undefined, fetchedAt: number, items: VenueDeadline[]) {
  const file = cachePath(profile)
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
  await fs.writeFile(file, `${JSON.stringify({ fetchedAt, items })}\n`, 'utf-8').catch(() => undefined)
}

export async function loadVenueCatalog(profile?: string, force = false): Promise<VenueCatalog> {
  const cached = await readCache(profile)
  const now = Date.now()
  if (!force && cached && now - cached.fetchedAt < TTL_MS) {
    return { items: cached.items, fetchedAt: cached.fetchedAt, stale: false, error: '' }
  }
  try {
    const response = await fetch(SOURCE, {
      headers: { 'User-Agent': 'ekko-research/1.0 (+local)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    const items = parseCatalog(text, now)
    if (!items.length) throw new Error('目录为空或格式变化')
    await writeCache(profile, now, items)
    return { items, fetchedAt: now, stale: false, error: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (cached) {
      return { items: cached.items, fetchedAt: cached.fetchedAt, stale: true, error: `拉取失败，用缓存：${message}` }
    }
    return { items: [], fetchedAt: 0, stale: false, error: `拉取失败：${message}` }
  }
}

export function filterCatalog(
  catalog: VenueDeadline[],
  options: { query?: string; ccf?: string; limit?: number } = {},
): VenueDeadline[] {
  const query = (options.query || '').trim().toLowerCase()
  const ccf = (options.ccf || '').trim().toUpperCase()
  const limit = Math.min(Math.max(options.limit || 40, 1), 200)
  const today = new Date().toISOString().slice(0, 10)
  return catalog
    .filter(item => item.deadline >= today)
    .filter(item => (ccf ? item.ccf.toUpperCase() === ccf : true))
    .filter(item => (query ? `${item.name} ${item.fullName}`.toLowerCase().includes(query) : true))
    .slice(0, limit)
}
