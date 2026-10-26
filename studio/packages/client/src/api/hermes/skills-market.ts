import { request } from '../client'
import type { SkillTarget } from './skills'

export interface SkillsMarketEntry {
  id: string
  /** SkillHub slug; also the directory name used when installing. */
  slug: string
  name: string
  author: string
  description: string
  /** Simplified Chinese rendering of `description`, from SkillHub or filled in on demand. */
  descriptionZh?: string
  stars: number
  /** Install count; SkillHub's primary popularity signal. */
  downloads: number
  updatedAt: number
  /** Upstream GitHub URL when SkillHub knows one; usually empty. */
  githubUrl: string
  skillUrl: string
  contentLanguage: string
  /** Category id assigned by SkillHub (dev-programming / design-media / …). */
  category: string
  /** Chinese scene labels from SkillHub (代码生成 / 文档处理 / 工作流编排 …). */
  scenes?: string[]
}

export interface SkillsMarketPage {
  skills: SkillsMarketEntry[]
  page: number
  limit: number
  total: number
  hasNext: boolean
  query: string
  cached?: boolean
  stale?: boolean
  fetchedAt: number
}

export interface SkillsMarketQuery {
  q?: string
  page?: number
  limit?: number
  sortBy?: 'stars' | 'recent' | 'relevance'
  refresh?: boolean
}

export async function searchSkillsMarket(params: SkillsMarketQuery = {}): Promise<SkillsMarketPage> {
  const search = new URLSearchParams()
  if (params.q) search.set('q', params.q)
  if (params.page) search.set('page', String(params.page))
  if (params.limit) search.set('limit', String(params.limit))
  if (params.sortBy) search.set('sortBy', params.sortBy)
  if (params.refresh) search.set('refresh', '1')
  const query = search.toString()
  return request<SkillsMarketPage>(`/api/hermes/skills-market/search${query ? `?${query}` : ''}`)
}

export async function translateSkillsMarket(texts: string[]): Promise<string[]> {
  const res = await request<{ translations: string[] }>('/api/hermes/skills-market/translate', {
    method: 'POST',
    body: JSON.stringify({ texts }),
  })
  return res.translations || []
}

export const installSkillsMarketEntry = (entry: {
  name?: string
  slug?: string
  githubUrl?: string
  /** Category folder under the skills root; omitted installs at the root (misc). */
  category?: string
  /** Agent whose skill tree receives the package. The server falls back to Hermes. */
  target?: SkillTarget
}) =>
  request<{ name: string; files: number; category?: string }>('/api/hermes/skills-market/install', {
    method: 'POST',
    body: JSON.stringify(entry),
  })
