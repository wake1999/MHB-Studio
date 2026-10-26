import { request, getBaseUrlValue, getApiKey, getActiveProfileName } from '../client'
import { fetchAgentAvailabilitySnapshot } from '../agent-status'

export type SkillSource = 'builtin' | 'hub' | 'local' | 'external'
export type SkillTarget = 'ekko' | 'hermes' | 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'antigravity'

/** Every agent the skill pages can read from, product agent first. */
export const SKILL_TARGETS: SkillTarget[] = ['ekko', 'hermes', 'claude', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity']

/** Maps the availability snapshot ids onto skill targets; unknown agents have no skill tree here. */
export const SKILL_TARGET_BY_AGENT_STATUS: Record<string, SkillTarget> = {
  'ekko-agent': 'ekko',
  hermes: 'hermes',
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'cursor',
  antigravity: 'antigravity',
}

export interface SkillInfo {
  name: string
  description: string
  enabled?: boolean
  source?: SkillSource
  readonly?: boolean
  modified?: boolean
  patchCount?: number
  useCount?: number
  viewCount?: number
  pinned?: boolean
  /** External skills only — raw form of the configured external dir (e.g. `~/my_skills/...`),
   *  used by the UI to group external skills by their source path. */
  sourcePath?: string
}

export interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

/** A category folder directly under the skills root; `count` is its skill dirs. */
export interface SkillCategoryInfo {
  name: string
  description: string
  count: number
  /** True for folders the user created from the skill market. */
  custom?: boolean
}

export interface ExternalDirEntry {
  raw: string
  expanded: string
  exists: boolean
  isDir: boolean
}

export interface SkillPaths {
  local: string
  external: string[]
  /** Raw entries as written in `config.skills.external_dirs`, with existence
   *  flags so the UI can grey-out paths that don't currently resolve.
   *  Optional — older servers may not include it. */
  externalRaw?: ExternalDirEntry[]
}

export interface SkillListResponse {
  categories: SkillCategory[]
  archived: SkillInfo[]
  paths?: SkillPaths
}

export interface SkillFileEntry {
  path: string
  name: string
  isDir: boolean
}

export interface MemoryData {
  memory: string
  user: string
  soul: string
  memory_mtime: number | null
  user_mtime: number | null
  soul_mtime: number | null
}

export interface SkillsData {
  categories: SkillCategory[]
  archived: SkillInfo[]
  paths?: SkillPaths
}

export interface SkillUsageRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
  percentage: number
  last_used_at: number | null
}

export interface SkillUsageDailySkillRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
}

export interface SkillUsageDailyRow {
  date: string
  view_count: number
  manage_count: number
  total_count: number
  skills: SkillUsageDailySkillRow[]
}

export interface SkillUsageStats {
  period_days: number
  summary: {
    total_skill_loads: number
    total_skill_edits: number
    total_skill_actions: number
    distinct_skills_used: number
  }
  by_day: SkillUsageDailyRow[]
  top_skills: SkillUsageRow[]
}

/**
 * Skill trees the pages may offer: the product agent always comes first, then
 * whatever other agents are actually installed on this machine.
 */
export async function fetchInstalledSkillTargets(): Promise<SkillTarget[]> {
  try {
    const snapshot = await fetchAgentAvailabilitySnapshot()
    const installed: SkillTarget[] = []
    for (const record of snapshot.agents || []) {
      if (!record.installed || record.source === 'not-installed') continue
      const target = SKILL_TARGET_BY_AGENT_STATUS[record.id]
      if (target && !installed.includes(target)) installed.push(target)
    }
    return ['ekko', ...installed.filter(target => target !== 'ekko')]
  } catch {
    return ['ekko', 'hermes']
  }
}

export async function fetchSkills(profile?: string, target: SkillTarget = 'hermes'): Promise<SkillsData> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  if (target !== 'hermes') params.set('target', target)
  const query = params.toString() ? `?${params.toString()}` : ''
  const res = await request<SkillListResponse>(`/api/hermes/skills${query}`)
  return { categories: res.categories, archived: res.archived ?? [], paths: res.paths }
}

export async function fetchSkillUsageStats(days = 7): Promise<SkillUsageStats> {
  const params = new URLSearchParams({ days: String(days) })
  return request<SkillUsageStats>(`/api/hermes/skills/usage/stats?${params}`)
}

function targetQuery(target: SkillTarget = 'hermes'): string {
  if (target === 'hermes') return ''
  return `?target=${encodeURIComponent(target)}`
}

function encodeSkillPath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export async function fetchSkillContent(skillPath: string, target: SkillTarget = 'hermes'): Promise<string> {
  const res = await request<{ content: string }>(`/api/hermes/skills/${encodeSkillPath(skillPath)}${targetQuery(target)}`)
  return res.content
}

export async function saveSkillContent(
  category: string,
  skill: string,
  content: string,
  target: SkillTarget = 'hermes',
): Promise<void> {
  const c = encodeURIComponent(category)
  const s = encodeURIComponent(skill)
  await request(`/api/hermes/skills/${c}/${s}${targetQuery(target)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

export async function fetchSkillFiles(category: string, skill: string, target: SkillTarget = 'hermes'): Promise<SkillFileEntry[]> {
  const path = encodeSkillPath(`${category}/${skill}`)
  const res = await request<{ files: SkillFileEntry[] }>(`/api/hermes/skills/${path}/files${targetQuery(target)}`)
  return res.files
}

export async function fetchMemory(): Promise<MemoryData> {
  return request<MemoryData>('/api/hermes/memory')
}

export async function saveMemory(section: 'memory' | 'user' | 'soul', content: string): Promise<void> {
  await request('/api/hermes/memory', {
    method: 'POST',
    body: JSON.stringify({ section, content }),
  })
}

export async function toggleSkill(name: string, enabled: boolean): Promise<void> {
  await request('/api/hermes/skills/toggle', {
    method: 'PUT',
    body: JSON.stringify({ name, enabled }),
  })
}

/** One config write for a whole group; per-skill toggles would race each other. */
export async function toggleSkillsBatch(names: string[], enabled: boolean): Promise<void> {
  await request('/api/hermes/skills/toggle-batch', {
    method: 'PUT',
    body: JSON.stringify({ names, enabled }),
  })
}

export async function deleteSkillCategory(
  name: string,
  target: SkillTarget = 'hermes',
): Promise<{ removedSkills: number }> {
  return request<{ success: boolean; name: string; removedSkills: number }>(
    `/api/hermes/skills/categories/${encodeURIComponent(name)}${targetQuery(target)}`,
    { method: 'DELETE' },
  )
}

export async function pinSkillApi(name: string, pinned: boolean): Promise<void> {
  await request('/api/hermes/skills/pin', {
    method: 'PUT',
    body: JSON.stringify({ name, pinned }),
  })
}

/** Category folders, including ones that hold no skill yet. */
export async function fetchSkillCategories(target: SkillTarget = 'hermes'): Promise<SkillCategoryInfo[]> {
  const res = await request<{ categories: SkillCategoryInfo[] }>(
    `/api/hermes/skills/categories${targetQuery(target)}`,
  )
  return res.categories ?? []
}

export async function createSkillCategory(
  name: string,
  description = '',
  target: SkillTarget = 'hermes',
): Promise<void> {
  await request(`/api/hermes/skills/categories${targetQuery(target)}`, {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  })
}

export async function fetchExternalDirs(): Promise<ExternalDirEntry[]> {
  const res = await request<{ dirs: ExternalDirEntry[] }>('/api/hermes/skills/external-dirs')
  return res.dirs ?? []
}

export async function saveExternalDirs(dirs: string[]): Promise<void> {
  await request('/api/hermes/skills/external-dirs', {
    method: 'PUT',
    body: JSON.stringify({ dirs }),
  })
}

export async function deleteSkillApi(category: string, name: string, target: SkillTarget = 'hermes'): Promise<void> {
  const c = encodeURIComponent(category)
  const n = encodeURIComponent(name)
  await request(`/api/hermes/skills/${c}/${n}${targetQuery(target)}`, { method: 'DELETE' })
}

/**
 * Import one or more files (a single .zip OR a folder of files with relative paths).
 * For folder uploads, the caller should pass File objects whose `webkitRelativePath`
 * starts with the skill folder name; we forward those paths verbatim as the
 * `filename` parameter so the server can reconstruct the directory tree.
 */
export async function importSkill(files: File[], category?: string, target: SkillTarget = 'hermes'): Promise<{ name: string }> {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const profile = getActiveProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile

  const formData = new FormData()
  for (const f of files) {
    const relPath = (f as any).webkitRelativePath || f.name
    formData.append('file', f, relPath)
  }
  if (category) formData.append('category', category)

  const res = await fetch(`${baseUrl}/api/hermes/skills/import${targetQuery(target)}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  const text = await res.text()
  let payload: any = null
  try { payload = text ? JSON.parse(text) : null } catch { /* keep raw text */ }
  if (!res.ok) {
    throw new Error(payload?.error || text || `Import failed (${res.status})`)
  }
  return payload || { name: '' }
}
