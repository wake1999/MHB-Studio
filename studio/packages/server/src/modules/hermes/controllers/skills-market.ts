/**
 * Skills market: a thin proxy over the public SkillHub open API plus an
 * installer, so the client never talks to a third party directly and an
 * install can write straight into the active profile's skills directory.
 */
import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'

import AdmZip from 'adm-zip'

import { getActiveProfileName } from '../services/profiles/profile'
import { isPathWithin } from '../services/runtime/path'
import { resolveSkillTargetDirectory } from './skills'

const execFileAsync = promisify(execFile)

const SEARCH_ENDPOINT = 'https://api.skillhub.cn/api/skills'
const DOWNLOAD_ENDPOINT = 'https://api.skillhub.cn/api/v1/download'
const SEARCH_TTL_MS = 15 * 60 * 1000
const DISCOVER_TTL_MS = 6 * 60 * 60 * 1000
/** Client-facing page size cap; SkillHub itself accepts 1..100. */
const MAX_PAGE_SIZE = 48
const MAX_FILES = 300
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024
const MAX_DEPTH = 5
const GIT_TIMEOUT_MS = 180 * 1000
const MAX_TRANSLATE_BATCH = 30
const MAX_TRANSLATE_CHARS = 320

/** Cap per publisher so one prolific author cannot fill the whole grid. */
const MAX_PER_AUTHOR = 8

/**
 * Category rules, evaluated in order against the skill name and description.
 * The id is stable and translated on the client.
 */
const CATEGORY_RULES: Array<{ id: string; test: RegExp }> = [
  { id: 'testing', test: /\b(test|testing|qa|e2e|lint|debug|coverage|audit|review|assert)s?\b/i },
  { id: 'frontend', test: /\b(ui|ux|css|html|react|vue|svelte|tailwind|frontend|design system|component|figma|animation)s?\b/i },
  { id: 'docs', test: /\b(doc|docs|documentation|writing|markdown|readme|blog|content|editor|translate|ppt|slide|presentation)s?\b/i },
  { id: 'data', test: /\b(data|sql|database|analytics|etl|csv|spreadsheet|dashboard|metric|postgres|sqlite)s?\b/i },
  { id: 'devops', test: /\b(deploy|docker|kubernetes|ci|pipeline|release|git|worktree|repo|build|infra|server)s?\b/i },
  { id: 'media', test: /\b(image|video|audio|media|photo|pdf|ffmpeg|screenshot|voice)s?\b/i },
  { id: 'security', test: /\b(security|secret|auth|permission|vulnerab|credential|sandbox|safety)s?\b/i },
  { id: 'productivity', test: /\b(notion|slack|email|calendar|task|meeting|workflow|jira|linear|notes|reminder|inbox)s?\b/i },
  { id: 'ai', test: /\b(agent|llm|prompt|mcp|model|openai|claude|gemini|embedding|rag)s?\b/i },
]

interface MarketSkill {
  id: string
  /** SkillHub slug, also the directory name used when installing. */
  slug: string
  name: string
  author: string
  description: string
  /** Chinese summary supplied by SkillHub itself. */
  descriptionZh?: string
  stars: number
  /** Install count; SkillHub's primary popularity signal. */
  downloads: number
  updatedAt: number
  /** Upstream GitHub URL when SkillHub knows one; usually empty. */
  githubUrl: string
  skillUrl: string
  contentLanguage: string
  category: string
  /** Chinese scene labels from SkillHub's sub-categories (代码生成 / 文档处理 / …). */
  scenes: string[]
}

interface MarketPage {
  skills: MarketSkill[]
  page: number
  limit: number
  total: number
  hasNext: boolean
}

interface CacheEntry {
  at: number
  data: MarketPage
}

const cache = new Map<string, CacheEntry>()
let cacheLoaded = false

function cacheFile(): string {
  return join(homedir(), '.hermes', 'cache', 'skills-market.json')
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), 'utf-8')) as Record<string, CacheEntry>
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.at === 'number' && value.data) cache.set(key, value)
    }
  } catch {
    // First run, or an unreadable cache file: nothing to warm up.
  }
}

async function persistCache(): Promise<void> {
  try {
    const target = cacheFile()
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(Object.fromEntries(cache)), 'utf-8')
  } catch {
    // The cache is an optimisation; a failed write must not fail the request.
  }
}

async function withCache(
  key: string,
  ttl: number,
  force: boolean,
  loader: () => Promise<MarketPage>,
): Promise<MarketPage & { cached: boolean; stale?: boolean }> {
  await loadCache()
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < ttl) return { ...hit.data, cached: true }
  try {
    const data = await loader()
    cache.set(key, { at: Date.now(), data })
    void persistCache()
    return { ...data, cached: false }
  } catch (err) {
    if (hit) return { ...hit.data, cached: true, stale: true }
    throw err
  }
}

function classify(name: string, description: string): string {
  const haystack = `${name} ${description}`
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(haystack)) return rule.id
  }
  return 'other'
}

/** Map the client's sort vocabulary onto the values SkillHub accepts. */
function sortParam(sortBy: string): string | null {
  switch (sortBy) {
    case 'stars': return 'stars'
    case 'recent': return 'updated_at'
    case 'downloads': return 'downloads'
    default: return null
  }
}

/** Some publishers ship the summary as a JSON blob; unwrap it so cards stay readable. */
function cleanText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed)
      for (const key of ['answer', 'description', 'summary', 'text', 'content']) {
        const value = parsed?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    } catch {
      // Not JSON after all: keep the original text.
    }
  }
  return trimmed
}

function normaliseSkill(raw: any): MarketSkill {
  const name = String(raw?.name || raw?.slug || '')
  const slug = String(raw?.slug || '')
  const handle = String(raw?.namespace?.handle || '')
  const descriptionZh = cleanText(String(raw?.description_zh || ''))
  const description = cleanText(String(raw?.description || '')) || descriptionZh
  const scenes: string[] = Array.isArray(raw?.subCategories)
    ? Array.from(new Set<string>(
        raw.subCategories.map((item: any) => String(item?.name || '').trim()).filter(Boolean),
      )).slice(0, 4)
    : []
  return {
    id: slug || String(raw?.id || name),
    slug,
    name,
    author: String(raw?.ownerName || raw?.namespace?.displayName || handle || ''),
    description,
    descriptionZh: descriptionZh || undefined,
    stars: Number(raw?.stars || 0),
    downloads: Number(raw?.downloads || raw?.installs || 0),
    updatedAt: Number(raw?.updated_at || raw?.created_at || 0),
    githubUrl: String(raw?.upstream_url || ''),
    // homepage points at the API host; the public site lives under /skills.
    skillUrl: handle && slug
      ? `https://www.skillhub.cn/skills/${handle}/${slug}`
      : String(raw?.homepage || ''),
    contentLanguage: descriptionZh ? 'zh' : 'en',
    category: String(raw?.category || '') || classify(name, description),
    scenes,
  }
}

async function searchSkillHub(query: string, page: number, limit: number, sortBy: string): Promise<MarketPage> {
  // SkillHub's hard ceiling is 100; the discover seed legitimately asks for that many.
  const size = Math.min(100, Math.max(1, limit))
  const search = new URLSearchParams({
    page: String(page),
    pageSize: String(size),
    order: 'desc',
  })
  if (query) search.set('keyword', query)
  const sort = sortParam(sortBy)
  if (sort) search.set('sortBy', sort)

  const res = await fetch(`${SEARCH_ENDPOINT}?${search.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'ekko-skills-market' },
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) {
    const error: any = new Error(`SkillHub responded ${res.status}`)
    error.status = res.status
    throw error
  }
  const payload: any = await res.json()
  if (!payload || payload.code !== 0) {
    const error: any = new Error(payload?.message || 'SkillHub search failed')
    error.status = 502
    throw error
  }
  const data = payload.data || {}
  const total = Number(data.total || 0)
  const skills = (Array.isArray(data.skills) ? data.skills : []).map(normaliseSkill)
  return {
    skills,
    page,
    limit: size,
    total,
    // SkillHub returns no pagination block, so derive it from the total; an
    // empty page also ends the walk in case the upstream page cap is reached.
    hasNext: skills.length > 0 && page * size < total,
  }
}

/**
 * Discover = the download leaderboard, paged through so the grid is not capped
 * at one page. Publisher diversity is enforced per page.
 */
async function discoverSkills(page: number, limit: number): Promise<MarketPage> {
  const data = await searchSkillHub('', page, limit, 'downloads')
  const seen = new Set<string>()
  const perAuthor = new Map<string, number>()
  const skills: MarketSkill[] = []
  for (const skill of data.skills) {
    if (!skill.name || !skill.slug || seen.has(skill.name)) continue
    const authorKey = skill.author || 'unknown'
    const used = perAuthor.get(authorKey) || 0
    if (used >= MAX_PER_AUTHOR) continue
    perAuthor.set(authorKey, used + 1)
    seen.add(skill.name)
    skills.push(skill)
  }
  return { skills, page: data.page, limit: data.limit, total: data.total, hasNext: data.hasNext }
}

/* ------------------------------------------------------------------ */
/* Chinese descriptions                                                */
/* ------------------------------------------------------------------ */

let translationStore: Record<string, string> | null = null
let envKey: string | null | undefined

function readDotEnvKey(name: string): string {
  try {
    const raw = readFileSync(join(homedir(), '.hermes', '.env'), 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.startsWith(`${name}=`)) continue
      return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // No .env file: fall back to the process environment.
  }
  return ''
}

function deepseekKey(): string {
  if (envKey === undefined) envKey = process.env.DEEPSEEK_API_KEY || readDotEnvKey('DEEPSEEK_API_KEY')
  return envKey || ''
}

function translationFile(): string {
  return join(homedir(), '.hermes', 'cache', 'skills-market-zh.json')
}

async function loadTranslations(): Promise<Record<string, string>> {
  if (translationStore) return translationStore
  try {
    translationStore = JSON.parse(await readFile(translationFile(), 'utf-8')) as Record<string, string>
  } catch {
    translationStore = {}
  }
  return translationStore
}

async function persistTranslations(): Promise<void> {
  if (!translationStore) return
  try {
    const target = translationFile()
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(translationStore), 'utf-8')
  } catch {
    // Best effort: the in-memory cache still serves the current process.
  }
}

function descriptionHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

async function translateTexts(texts: string[]): Promise<string[]> {
  const store = await loadTranslations()
  const result = texts.map(text => store[descriptionHash(text.trim())] || '')
  const pending: Array<{ index: number; text: string }> = []
  texts.forEach((text, index) => {
    const trimmed = text.trim()
    if (trimmed && !result[index]) pending.push({ index, text: trimmed.slice(0, MAX_TRANSLATE_CHARS) })
  })

  const key = deepseekKey()
  const batch = pending.slice(0, MAX_TRANSLATE_BATCH)
  if (!key || batch.length === 0) return result

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.2,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: '你是技能市场的中文编辑。把每条英文技能简介翻译成简体中文，保留专有名词（技术名词、产品名）原文；每条不超过45个字；只输出 JSON 字符串数组，顺序和条数必须与输入一致。',
          },
          { role: 'user', content: JSON.stringify(batch.map(item => item.text)) },
        ],
      }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) return result
    const payload: any = await res.json()
    const content = String(payload?.choices?.[0]?.message?.content || '')
    const match = content.match(/\[[\s\S]*\]/)
    if (!match) return result
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed) || parsed.length !== batch.length) return result
    batch.forEach((item, idx) => {
      const zh = String(parsed[idx] || '').trim()
      if (!zh) return
      store[descriptionHash(item.text)] = zh
      result[item.index] = zh
    })
    void persistTranslations()
  } catch {
    // Translation is a nicety: leave the English text in place on any failure.
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Install                                                            */
/* ------------------------------------------------------------------ */

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

/** The target agent defaults to the one the client picked; Hermes keeps the historical fallback. */
function skillsDirFor(ctx: any, rawTarget?: unknown): string {
  return resolveSkillTargetDirectory(rawTarget, requestedProfile(ctx)).directory
}

function isValidSkillName(name: string): boolean {
  if (!name) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return true
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readManifestNames(skillsDir: string): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    const manifest = await readFile(join(skillsDir, '.bundled_manifest'), 'utf-8')
    for (const line of manifest.split('\n')) {
      const name = line.split(':')[0]?.trim()
      if (name) names.add(name)
    }
  } catch {
    // No bundled manifest in this profile.
  }
  try {
    const lock = JSON.parse(await readFile(join(skillsDir, '.hub', 'lock.json'), 'utf-8')) as any
    for (const key of Object.keys(lock?.skills || lock?.installed || {})) names.add(key)
  } catch {
    // No hub lock file in this profile.
  }
  return names
}

interface GithubTarget {
  owner: string
  repo: string
  branch: string
  path: string
}

function parseGithubUrl(raw: string): GithubTarget | null {
  try {
    const url = new URL(raw)
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const [owner, repo, kind, ...rest] = parts
    if (kind !== 'tree' && kind !== 'blob') return null
    const branch = rest.shift()
    if (!branch) return null
    return { owner, repo, branch, path: rest.join('/') }
  } catch {
    return null
  }
}

/** List files under a directory as paths relative to it, bounded in size and depth. */
async function listSkillFiles(root: string, prefix = '', depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  const entries = await readdir(join(root, prefix || '.'), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break
    if (entry.name === '.git') continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await listSkillFiles(root, rel, depth + 1))
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(join(root, rel)).catch(() => null)
    if (!info || info.size > MAX_FILE_BYTES) continue
    files.push(rel)
  }
  return files
}

/**
 * Copy the skill directory out of GitHub with a partial, sparse clone. This
 * avoids both the anonymous 60 requests/hour API cap and the raw host, which
 * some networks reset.
 */
async function cloneSkillDirectory(target: GithubTarget, destination: string): Promise<number> {
  const staging = join(tmpdir(), `ekko-skill-${randomBytes(6).toString('hex')}`)
  const mirror = String(process.env.SKILLS_GIT_MIRROR || '').trim()
  const cloneUrl = `${mirror}https://github.com/${target.owner}/${target.repo}.git`
  try {
    await execFileAsync('git', [
      'clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', target.branch,
      cloneUrl, staging,
    ], { timeout: GIT_TIMEOUT_MS, windowsHide: true })
    if (target.path) {
      await execFileAsync('git', [
        '-C', staging, 'sparse-checkout', 'set', '--no-cone', `${target.path}/**`,
      ], { timeout: GIT_TIMEOUT_MS, windowsHide: true })
    }

    const source = target.path ? join(staging, target.path) : staging
    if (!await pathExists(join(source, 'SKILL.md'))) {
      throw Object.assign(new Error('SKILL.md was not found in that GitHub directory'), { status: 422 })
    }

    const files = await listSkillFiles(source)
    await mkdir(destination, { recursive: true })
    for (const rel of files) {
      const from = join(source, rel)
      const to = join(destination, rel)
      if (!isPathWithin(to, destination)) continue
      await mkdir(dirname(to), { recursive: true })
      await cp(from, to)
    }
    return files.length
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** GET /api/hermes/skills-market/search — Discover (no q) or keyword search. */
export async function search(ctx: any) {
  const query = String(ctx.query?.q || '').trim()
  const page = Math.max(1, Number(ctx.query?.page) || 1)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(ctx.query?.limit) || 24))
  const sortRaw = String(ctx.query?.sortBy || 'stars')
  const sortBy = ['stars', 'recent', 'relevance', 'downloads'].includes(sortRaw) ? sortRaw : 'stars'
  const force = String(ctx.query?.refresh || '') === '1'

  try {
    if (!query) {
      const data = await withCache(
        `discover:v4:${page}:${limit}`,
        DISCOVER_TTL_MS,
        force,
        () => discoverSkills(page, limit),
      )
      ctx.body = { ...data, query: '', fetchedAt: Date.now() }
      return
    }
    const data = await withCache(
      // v2 dropped the SkillsMP payload shape, so old entries must not be reused.
      `s:v2:${query}:${page}:${limit}:${sortBy}`,
      SEARCH_TTL_MS,
      force,
      () => searchSkillHub(query, page, limit, sortBy),
    )
    ctx.body = { ...data, query, fetchedAt: Date.now() }
  } catch (err: any) {
    ctx.status = err?.status === 429 ? 429 : 502
    ctx.body = { error: err?.message || 'Skills market request failed' }
  }
}

/** POST /api/hermes/skills-market/translate — batch English descriptions into Chinese. */
export async function translate(ctx: any) {
  const body = (ctx.request.body || {}) as { texts?: unknown }
  const texts = Array.isArray(body.texts)
    ? body.texts.map(item => String(item || '')).slice(0, MAX_TRANSLATE_BATCH)
    : []
  if (texts.length === 0) {
    ctx.body = { translations: [] }
    return
  }
  try {
    ctx.body = { translations: await translateTexts(texts) }
  } catch {
    ctx.body = { translations: texts.map(() => '') }
  }
}

/** Fetch a SkillHub package as a zip and unpack it, refusing zip-slip and oversized payloads. */
async function downloadSkillHubPackage(slug: string, destination: string): Promise<number> {
  const res = await fetch(`${DOWNLOAD_ENDPOINT}?slug=${encodeURIComponent(slug)}&source=dsh`, {
    headers: { 'User-Agent': 'ekko-skills-market' },
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const error: any = new Error(`SkillHub download responded ${res.status}`)
    error.status = res.status === 404 ? 404 : 502
    throw error
  }
  if (Number(res.headers.get('content-length') || 0) > MAX_PACKAGE_BYTES) {
    throw Object.assign(new Error('Skill package is too large'), { status: 413 })
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength > MAX_PACKAGE_BYTES) {
    throw Object.assign(new Error('Skill package is too large'), { status: 413 })
  }

  let entries: ReturnType<AdmZip['getEntries']> = []
  try {
    entries = new AdmZip(buffer).getEntries().filter(entry => !entry.isDirectory)
  } catch {
    // AdmZip parses lazily, so a corrupt payload only fails on getEntries().
  }
  if (entries.length === 0) {
    throw Object.assign(new Error('SkillHub returned an unreadable package'), { status: 502 })
  }
  if (entries.length > MAX_FILES) {
    throw Object.assign(new Error('Skill package contains too many files'), { status: 422 })
  }

  const relative = entries.map(entry => entry.entryName.replace(/\\/g, '/').replace(/^\.\//, ''))
  if (!relative.includes('SKILL.md')) {
    throw Object.assign(new Error('SKILL.md was not found in the package'), { status: 422 })
  }

  await mkdir(destination, { recursive: true })
  let written = 0
  for (let index = 0; index < entries.length; index += 1) {
    const rel = relative[index]
    if (!rel) continue
    if (entries[index].header.size > MAX_FILE_BYTES) continue
    const to = join(destination, rel)
    if (!isPathWithin(to, destination)) continue
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, entries[index].getData())
    written += 1
  }
  if (written === 0) {
    throw Object.assign(new Error('Skill package had no usable files'), { status: 422 })
  }
  return written
}

/** POST /api/hermes/skills-market/install — unpack a SkillHub package into the profile. */
export async function install(ctx: any) {
  const body = (ctx.request.body || {}) as { name?: unknown; slug?: unknown; githubUrl?: unknown; category?: unknown; target?: unknown }
  const slug = String(body.slug || '').trim()
  const githubUrl = String(body.githubUrl || '').trim()
  const category = String(body.category || '').trim()
  const target = githubUrl ? parseGithubUrl(githubUrl) : null
  if (!target && !slug) {
    ctx.status = 400
    ctx.body = { error: 'Provide a SkillHub slug or a GitHub tree URL' }
    return
  }

  // The category is one path segment under the skills root; `misc` is the
  // synthetic bucket the scanner builds for root-level skills, never a folder.
  if (category && (category === 'misc' || !isValidSkillName(category))) {
    ctx.status = 400
    ctx.body = { error: 'Invalid category name' }
    return
  }

  const fallback = target
    ? target.path.split('/').filter(Boolean).pop() || target.repo
    : slug
  let name = String(body.name || '').trim() || fallback
  // Display names may contain spaces or slashes; the slug is always path safe.
  if (!isValidSkillName(name)) name = slug
  if (!isValidSkillName(name)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid skill name' }
    return
  }

  const skillsDir = skillsDirFor(ctx, body.target)
  const targetRoot = category ? join(skillsDir, category) : skillsDir
  const destination = join(targetRoot, name)
  if (!isPathWithin(destination, skillsDir)) {
    ctx.status = 400
    ctx.body = { error: 'Resolved target path escapes the skills directory' }
    return
  }
  if (await pathExists(destination)) {
    ctx.status = 409
    ctx.body = { error: `Skill "${name}" already exists` }
    return
  }
  if ((await readManifestNames(skillsDir)).has(name)) {
    ctx.status = 409
    ctx.body = { error: `Skill "${name}" conflicts with a bundled or hub-managed skill` }
    return
  }

  try {
    await mkdir(targetRoot, { recursive: true })
    const files = target
      ? await cloneSkillDirectory(target, destination)
      : await downloadSkillHubPackage(slug, destination)
    ctx.body = { name, files, category: category || undefined }
  } catch (err: any) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    const detail = String(err?.stderr || err?.message || '').split('\n').filter(Boolean).pop() || 'Install failed'
    ctx.status = err?.status || 502
    ctx.body = { error: detail }
  }
}
