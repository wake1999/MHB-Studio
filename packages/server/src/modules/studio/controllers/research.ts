/**
 * Research workspace endpoints.
 *
 * The whole document is returned in one payload: the nine views all read the
 * same small JSON, so per-view endpoints would only add round trips. Mutations
 * are generic per collection, which keeps the surface honest — the agent tools
 * and the panel go through the same `updateStore` path.
 */
import {
  RESEARCH_COLLECTIONS,
  type ResearchChange,
  type ResearchCollection,
  type ResearchVenueRef,
  collectionItems,
  isResearchCollection,
  newId,
  projectScoped,
  readChangeLog,
  readStore,
  researchRoot,
  subscribeResearchEvents,
  updateStore,
} from '../services/research/store'
import { searchArxiv } from '../services/research/arxiv'
import { readLastCompile, runCompile } from '../services/research/compile'
import { buildDeck, listDecks, readDeck, readDeckBytes, removeDeckFile } from '../services/research/deck'
import { buildDeckPreview } from '../services/research/deck-preview'
import {
  appendBibliographyEntries,
  deleteProjectFigure,
  openPaperPdf,
  readBibliography,
  readProjectFigure,
  renameProjectFigure,
  saveProjectFigure,
  readCompileStatus,
  readPaperSource,
  readSnapshotFile,
  writeBibliography,
  writePaperSource,
  writePaperSourceOptimistic,
  writeSnapshotFile,
} from '../services/research/paper'
import { entryFromPaper, type BibEntry } from '../services/research/bibtex'
import { jobState, probeServer, submitJob } from '../services/research/ssh'
import { filterCatalog, loadVenueCatalog } from '../services/research/venues'
import {
  exportZoteroCollectionToBib,
  importZoteroItem,
  listZoteroCollections,
  probeZotero,
  searchZoteroItems,
} from '../services/research/zotero'
import { digestView, evidenceGraphView, foragingView, momentIndexView, worktreeView } from '../services/research/ledger-views'
import { readArtifactView } from '../services/research/artifacts'
import { addEvidenceEdge, addJournalEntry, retractEvidenceEdge } from '../services/research/ledger-writes'
import { fetchPaperPdf, readPaperPdfFile } from '../services/research/pdf'
import { importProject } from '../services/research/project-import'
import { convertProjectFigure } from '../services/research/figures'
import {
  getImageGenConfig,
  getSxngConfig,
  searchWeb,
  setImageGenConfig,
  setSxngConfig,
} from '../services/research/settings'

const MAX_ITEM_BYTES = 64 * 1024
const MAX_STRING = 20_000

function profileOf(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

function fail(ctx: any, status: number, error: string, code = 'invalid_request') {
  ctx.status = status
  ctx.body = { error, code }
}

function readBody(ctx: any): Record<string, unknown> | null {
  const body = ctx.request?.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  let serialized: string
  try {
    serialized = JSON.stringify(body)
  } catch {
    return null
  }
  if (serialized.length > MAX_ITEM_BYTES) return null
  return body as Record<string, unknown>
}

function cleanString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, MAX_STRING)
}

/** Keep only plain JSON the views can trust; never let a caller set the id. */
function sanitize(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (key === 'id' || key === 'updatedAt' || key === 'version') continue
    if (raw === null) {
      out[key] = null
    } else if (typeof raw === 'string') {
      out[key] = raw.slice(0, MAX_STRING)
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw
    } else if (typeof raw === 'boolean') {
      out[key] = raw
    } else if (Array.isArray(raw)) {
      out[key] = raw
        .filter(item => item === null || ['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'object' && item !== null))
        .slice(0, 500)
        .map(item => (item && typeof item === 'object' ? sanitize(item as Record<string, unknown>) : item))
    }
  }
  return out
}

function collectionOf(ctx: any): ResearchCollection | null {
  const value = String(ctx.params?.collection || '')
  return isResearchCollection(value) ? value : null
}

// GET /api/studio/research/state
export async function getState(ctx: any) {
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  // `root` 让面板能拼出工程的绝对目录：会话里的 agent 跑在别的 cwd 上，
  // 相对路径 `projects/<id>` 到它手里会指空（见 mimir 的 prompt builder）。
  ctx.body = { store, changes: await readChangeLog(profile, 50), root: researchRoot(profile) }
}

// POST /api/studio/research/projects  body: { title }
export async function createProject(ctx: any) {
  const body = readBody(ctx)
  const title = cleanString(body?.title).trim() || '未命名项目'
  const now = Date.now()
  const project = await updateStore(profileOf(ctx), 'project.created', store => {
    const created = { id: newId('proj'), title, createdAt: now, updatedAt: now }
    store.projects.push(created)
    return created
  })
  ctx.body = { project }
}

// PATCH /api/studio/research/projects/:id  body: { title }
export async function updateProject(ctx: any) {
  const id = String(ctx.params.id || '')
  const title = cleanString(readBody(ctx)?.title).trim()
  if (!title) return fail(ctx, 400, 'Missing title')
  const project = await updateStore(profileOf(ctx), 'project.updated', store => {
    const target = store.projects.find(item => item.id === id)
    if (!target) return null
    target.title = title
    target.updatedAt = Date.now()
    return target
  })
  if (!project) return fail(ctx, 404, 'Project not found', 'not_found')
  ctx.body = { project }
}

// DELETE /api/studio/research/projects/:id
export async function deleteProject(ctx: any) {
  const id = String(ctx.params.id || '')
  const removed = await updateStore(profileOf(ctx), 'project.deleted', store => {
    const index = store.projects.findIndex(item => item.id === id)
    if (index < 0) return null
    const [project] = store.projects.splice(index, 1)
    let cascaded = 0
    for (const collection of RESEARCH_COLLECTIONS) {
      const items = collectionItems(store, collection)
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].projectId === id) {
          items.splice(i, 1)
          cascaded += 1
        }
      }
    }
    return { project, cascaded }
  })
  if (!removed) return fail(ctx, 404, 'Project not found', 'not_found')
  ctx.body = removed
}

// POST /api/studio/research/items/:collection  body: item fields
export async function createItem(ctx: any) {
  const collection = collectionOf(ctx)
  if (!collection) return fail(ctx, 400, 'Unknown collection')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')

  const projectId = cleanString(body.projectId).trim()
  if (projectScoped(collection) && !projectId) return fail(ctx, 400, 'Missing projectId')

  const draft = sanitize(body)
  const item = await updateStore(profileOf(ctx), `${collection}.created`, store => {
    if (projectId && !store.projects.some(project => project.id === projectId)) return null
    const record = { ...draft, id: newId(collection), projectId } as Record<string, unknown> & { id: string }
    if (!('at' in record) && collection !== 'papers') record.at = Date.now()
    collectionItems(store, collection).push(record)
    return record
  })
  if (!item) return fail(ctx, 404, 'Project not found', 'not_found')
  ctx.body = { item }
}

// PATCH /api/studio/research/items/:collection/:id  body: partial fields
export async function updateItem(ctx: any) {
  const collection = collectionOf(ctx)
  if (!collection) return fail(ctx, 400, 'Unknown collection')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const id = String(ctx.params.id || '')
  const patch = sanitize(body)

  const item = await updateStore(profileOf(ctx), `${collection}.updated`, store => {
    const target = collectionItems(store, collection).find(entry => entry.id === id)
    if (!target) return null
    Object.assign(target, patch)
    return target
  })
  if (!item) return fail(ctx, 404, 'Item not found', 'not_found')
  ctx.body = { item }
}

// DELETE /api/studio/research/items/:collection/:id
export async function deleteItem(ctx: any) {
  const collection = collectionOf(ctx)
  if (!collection) return fail(ctx, 400, 'Unknown collection')
  const id = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  const removed = await updateStore(profile, `${collection}.deleted`, store => {
    const items = collectionItems(store, collection)
    const index = items.findIndex(entry => entry.id === id)
    if (index < 0) return null
    const [record] = items.splice(index, 1)
    return record
  })
  if (!removed) return fail(ctx, 404, 'Item not found', 'not_found')
  // A deck without its record is unreachable from the panel, so take the file too.
  if (collection === 'decks') await removeDeckFile(removed, profile)
  ctx.body = { ok: true }
}

/**
 * GET /api/studio/research/events?token=...
 * Server-sent `change` events so the panel can refresh the moment the agent (or
 * a second window) writes. EventSource cannot set headers, hence the query token.
 */
export async function events(ctx: any) {
  const res = ctx.res
  ctx.respond = false
  ctx.status = 200
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const send = (change: ResearchChange) => {
    res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
  }
  const unsubscribe = subscribeResearchEvents(send)
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 25_000)

  const close = () => {
    clearInterval(heartbeat)
    unsubscribe()
    try {
      res.end()
    } catch {
      // The socket may already be gone.
    }
  }
  ctx.req.on('close', close)
  ctx.req.on('aborted', close)
}

/* ------------------------------------------------------------------ arxiv */

// GET /api/studio/research/arxiv/search?query=&max=
export async function arxivSearch(ctx: any) {
  const query = String(ctx.query?.query || '')
  const max = Number(ctx.query?.max || 10)
  ctx.body = await searchArxiv(query, Number.isFinite(max) ? max : 10)
}

// POST /api/studio/research/projects/:id/papers/import-arxiv  body: { entry }
export async function importArxivPaper(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  const entry = (body?.entry || null) as Record<string, unknown> | null
  if (!entry || typeof entry !== 'object') return fail(ctx, 400, 'Missing entry')
  const arxivId = cleanString(entry.arxivId).trim()
  const title = cleanString(entry.title).trim()
  if (!arxivId || !title) return fail(ctx, 400, 'Missing arxivId or title')

  const result = await updateStore(profileOf(ctx), 'papers.imported', store => {
    if (!store.projects.some(project => project.id === projectId)) return null
    const existing = store.papers.find(
      paper => paper.projectId === projectId && paper.arxivId === arxivId,
    )
    if (existing) return { item: existing, duplicate: true }
    const item = {
      id: newId('paper'),
      projectId,
      title,
      authors: cleanString(entry.authors),
      year: cleanString(entry.year),
      venue: cleanString(entry.venue) || 'arXiv',
      doi: cleanString(entry.doi),
      url: cleanString(entry.url) || `https://arxiv.org/abs/${arxivId}`,
      arxivId,
      score: 0,
      status: 'new' as const,
      notes: cleanString(entry.summary),
      addedAt: Date.now(),
    }
    store.papers.unshift(item)
    return { item, duplicate: false }
  })
  if (!result) return fail(ctx, 404, 'Project not found', 'not_found')
  ctx.body = result
}

// POST /api/studio/research/items/subscriptions/:id/check
export async function checkSubscription(ctx: any) {
  const id = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const subscription = store.subscriptions.find(item => item.id === id)
  if (!subscription) return fail(ctx, 404, 'Subscription not found', 'not_found')

  const result = await searchArxiv(subscription.query, 25)
  if (result.error) {
    ctx.body = { ...result, added: [], total: 0 }
    return
  }
  const seen = new Set(subscription.seenIds || [])
  const fresh = result.entries.filter(entry => !seen.has(entry.arxivId))

  const added = await updateStore(profile, 'subscription.checked', working => {
    const target = working.subscriptions.find(item => item.id === id)
    if (!target) return []
    const projectId = target.projectId
    const created: Array<{ id: string; title: string; arxivId: string }> = []
    for (const entry of fresh) {
      const duplicate = working.papers.find(
        paper => paper.projectId === projectId && paper.arxivId === entry.arxivId,
      )
      if (duplicate) continue
      const item = {
        id: newId('paper'),
        projectId,
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        venue: entry.venue,
        doi: entry.doi,
        url: entry.url,
        arxivId: entry.arxivId,
        score: 0,
        status: 'new' as const,
        notes: entry.summary,
        addedAt: Date.now(),
      }
      working.papers.unshift(item)
      created.push({ id: item.id, title: item.title, arxivId: item.arxivId })
    }
    target.lastCheckedAt = Date.now()
    const merged = [...(target.seenIds || []), ...result.entries.map(entry => entry.arxivId)]
    target.seenIds = Array.from(new Set(merged)).slice(-2000)
    return created
  })
  ctx.body = { ...result, added, total: result.entries.length }
}

/* ------------------------------------------------------------------- paper */

// GET /api/studio/research/projects/:id/paper
export async function getPaper(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const paper = await readPaperSource(projectId, profileOf(ctx))
  if (!projectId) return fail(ctx, 400, 'Missing project id')
  ctx.body = { paper }
}

// PUT /api/studio/research/projects/:id/paper  body: { source }
export async function savePaper(ctx: any) {
  const projectId = String(ctx.params.id || '')
  // 源码天然会超过通用条目的 64KB 上限，所以这里直接读原始 body：
  // 长度交给 writePaperSource 的 1MB 上限裁决（超出回 413），
  // 否则 64KB~1MB 的稿件会被静默判成 Missing source。
  const raw = ctx.request?.body
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).source === 'string'
    ? (raw as Record<string, unknown>).source as string
    : null
  if (source === null) return fail(ctx, 400, 'Missing source')
  try {
    const paper = await writePaperSource(projectId, source, profileOf(ctx))
    await updateStore(profileOf(ctx), 'paper.saved', () => null, { projectId })
    ctx.body = { paper }
  } catch (error: any) {
    const code = error?.code || error?.message || ''
    if (code === 'file_too_large') return fail(ctx, 413, '源码过大', 'file_too_large')
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    return fail(ctx, 500, error?.message || '写入失败')
  }
}

/* ------------------------------------------------------------ bibliography */

const MAX_BIB_ENTRIES = 5000

/**
 * 校验客户端送来的条目表。形状不对就整体拒绝（返回 null），而不是写一半：
 * `references.bib` 是 latexmk 的输入，写进半条坏数据会让编译静默失败。
 */
function cleanBibEntries(input: unknown): BibEntry[] | null {
  if (!Array.isArray(input)) return null
  const out: BibEntry[] = []
  for (const raw of input.slice(0, MAX_BIB_ENTRIES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const row = raw as Record<string, unknown>
    const key = typeof row.key === 'string' ? row.key.trim() : ''
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : ''
    if (key === '' || type === '') return null
    const fields: Record<string, string> = {}
    const rawFields = row.fields
    if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
      for (const [name, value] of Object.entries(rawFields as Record<string, unknown>)) {
        const lower = name.trim().toLowerCase()
        if (lower === '' || typeof value !== 'string') continue
        fields[lower] = value.slice(0, MAX_STRING)
      }
    }
    out.push({ key: key.slice(0, 200), type: type.slice(0, 40), fields })
  }
  return out
}

// GET /api/studio/research/projects/:id/bibliography
export async function getBibliography(ctx: any) {
  const projectId = String(ctx.params.id || '')
  if (!projectId) return fail(ctx, 400, 'Missing project id')
  const bibliography = await readBibliography(projectId, profileOf(ctx))
  ctx.body = { bibliography }
}

// PUT /api/studio/research/projects/:id/bibliography  body: { entries, baseMtimeMs }
export async function saveBibliography(ctx: any) {
  const projectId = String(ctx.params.id || '')
  if (!projectId) return fail(ctx, 400, 'Missing project id')
  // 与 savePaper 同款：完整条目表可能超过通用 body 的 64KB 上限，长度交给
  // writeBibliography 的 1MB 上限裁决。
  const raw = ctx.request?.body
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(ctx, 400, 'Missing entries')
  const body = raw as Record<string, unknown>
  const entries = cleanBibEntries(body.entries)
  if (entries === null) return fail(ctx, 400, '条目格式不合法', 'invalid_entries')
  const base = body.baseMtimeMs
  const baseMtimeMs = typeof base === 'number' && Number.isFinite(base) ? base : null
  try {
    const saved = await writeBibliography(projectId, entries, baseMtimeMs, profileOf(ctx))
    await updateStore(profileOf(ctx), 'bib.saved', () => null)
    ctx.body = { mtimeMs: saved.mtimeMs }
  } catch (error: any) {
    const code = error?.code || error?.message || ''
    if (code === 'conflict') {
      // 面板读到 conflict 会冻结编辑器，让用户先重载，不覆盖别人的改动。
      ctx.status = 409
      ctx.body = { error: '参考文献已被其他改动更新', code: 'conflict', currentMtimeMs: error?.currentMtimeMs ?? null }
      return
    }
    if (code === 'bib_not_found') return fail(ctx, 409, '参考文献已被删除，请重载', 'bib_not_found')
    if (code === 'file_too_large') return fail(ctx, 413, '参考文献过大', 'file_too_large')
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    return fail(ctx, 500, error?.message || '写入失败')
  }
}

// POST /api/studio/research/projects/:id/papers/import-bib  body: { arxivIds }
export async function importPapersToBib(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  const ids = Array.isArray(body?.arxivIds)
    ? (body.arxivIds as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  if (ids.length === 0) return fail(ctx, 400, 'Missing arxivIds')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const wanted = new Set(ids)
  const papers = store.papers.filter(
    paper => paper.projectId === projectId && wanted.has(String(paper.arxivId || '')),
  )
  if (papers.length === 0) return fail(ctx, 404, '没有找到对应文献', 'paper_not_found')
  const entries = papers.map(paper => entryFromPaper({
    title: String(paper.title || ''),
    authors: String(paper.authors || ''),
    year: String(paper.year || ''),
    url: String(paper.url || ''),
    doi: String(paper.doi || ''),
    arxivId: String(paper.arxivId || ''),
  }))
  try {
    const result = await appendBibliographyEntries(projectId, entries, profile)
    await updateStore(profile, 'bib.imported', () => null)
    ctx.body = { added: result.added.length, skipped: result.skipped.length }
  } catch (error: any) {
    const code = error?.code || error?.message || ''
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    return fail(ctx, 500, error?.message || '导入失败')
  }
}

/** 一个项目保留的快照数（面板文案承诺的「保留最近 50 个」）。 */
const MAX_SNAPSHOTS_PER_PROJECT = 50

/**
 * 编译成功后捕获一份 `main.tex` 快照。上游同款语义：
 * - 只在编译成功时捕获；
 * - 内容与最新快照相同就跳过，避免自动保存 + 自动编译把列表刷爆；
 * - 任何 I/O 失败都吞掉——快照坏了不能影响「编译成功」这个结果；
 * - 每个项目只保留最近 50 条记录。
 */
async function captureSnapshot(projectId: string, profile?: string): Promise<void> {
  try {
    const paper = await readPaperSource(projectId, profile)
    if (!paper.exists) return
    const store = await readStore(profile)
    const previous = store.snapshots
      .filter(item => item.projectId === projectId)
      .sort((left, right) => right.at - left.at)[0]
    if (previous) {
      const last = await readSnapshotFile(projectId, previous.file, profile).catch(() => null)
      if (last === paper.source) return
    }
    const at = Date.now()
    const label = `编译快照 ${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}`
    const file = await writeSnapshotFile(projectId, label, paper.source, profile)
    await updateStore(profile, 'paper.snapshotted', (current) => {
      current.snapshots.unshift({
        id: newId('snap'),
        projectId,
        label,
        at,
        file: file.file,
        bytes: file.bytes,
      })
      const mine = current.snapshots.filter(item => item.projectId === projectId)
      if (mine.length > MAX_SNAPSHOTS_PER_PROJECT) {
        const drop = new Set(mine.slice(MAX_SNAPSHOTS_PER_PROJECT).map(item => item.id))
        current.snapshots = current.snapshots.filter(item => !drop.has(item.id))
      }
      return null
    })
  } catch {
    // 快照失败不进编译结果，静默略过
  }
}

// GET /api/studio/research/projects/:id/snapshots
export async function listSnapshots(ctx: any) {
  const projectId = String(ctx.params.id || '')
  if (!projectId) return fail(ctx, 400, 'Missing project id')
  const store = await readStore(profileOf(ctx))
  const snapshots = store.snapshots
    .filter(item => item.projectId === projectId)
    .sort((left, right) => right.at - left.at)
    .map(item => ({
      id: item.id,
      // 面板按 ISO 时间做「3 分钟前」这类相对显示
      createdAt: new Date(item.at).toISOString(),
      // ekko 的快照是整份 main.tex 一个文件，与上游按文件列的形状对齐
      files: [{ path: 'main.tex', sizeBytes: item.bytes }],
      sizeBytes: item.bytes,
      label: item.label,
    }))
  ctx.body = { snapshots }
}

// GET /api/studio/research/projects/:id/snapshots/:snapshotId
export async function getSnapshotContent(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const snapshotId = String(ctx.params.snapshotId || '')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const snapshot = store.snapshots.find(item => item.id === snapshotId && item.projectId === projectId)
  if (!snapshot) return fail(ctx, 404, 'Snapshot not found', 'not_found')
  try {
    const content = await readSnapshotFile(projectId, snapshot.file, profile)
    ctx.body = { id: snapshot.id, files: [{ path: 'main.tex', content }] }
  } catch {
    // 目录被清掉只剩 store 记录时，别让面板一直转圈
    return fail(ctx, 404, '快照文件已丢失', 'not_found')
  }
}

// POST /api/studio/research/projects/:id/snapshots  body: { label? }
export async function createSnapshot(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  const label = cleanString(body?.label).trim() || '手动快照'
  const profile = profileOf(ctx)
  const paper = await readPaperSource(projectId, profile)
  if (!paper.exists) return fail(ctx, 400, '还没有源码可快照')
  const file = await writeSnapshotFile(projectId, label, paper.source, profile)
  const snapshot = await updateStore(profile, 'paper.snapshot', store => {
    const record = {
      id: newId('snap'),
      projectId,
      label,
      at: Date.now(),
      file: file.file,
      bytes: file.bytes,
    }
    store.snapshots.unshift(record)
    store.snapshots = store.snapshots.slice(0, 200)
    return record
  })
  ctx.body = { snapshot }
}

// POST /api/studio/research/projects/:id/snapshots/:snapshotId/restore
export async function restoreSnapshot(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const snapshotId = String(ctx.params.snapshotId || '')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const snapshot = store.snapshots.find(
    item => item.id === snapshotId && item.projectId === projectId,
  )
  if (!snapshot) return fail(ctx, 404, 'Snapshot not found', 'not_found')
  // baseMtimeMs 只在调用方显式带上时才校验：老调用（不带这个字段）保持「无条件覆盖」
  // 的原行为，新的回滚路径必须带，否则一次误点就盖掉未保存的编辑。
  const body = readBody(ctx)
  const hasBase = body !== null && Object.prototype.hasOwnProperty.call(body, 'baseMtimeMs')
  const rawBase = body?.baseMtimeMs
  const baseMtimeMs = typeof rawBase === 'number' && Number.isFinite(rawBase) ? rawBase : null
  let source: string
  try {
    source = await readSnapshotFile(projectId, snapshot.file, profile)
  } catch {
    return fail(ctx, 404, '快照文件已丢失', 'not_found')
  }
  try {
    const paper = hasBase
      ? await writePaperSourceOptimistic(projectId, source, baseMtimeMs, profile)
      : await writePaperSource(projectId, source, profile)
    await updateStore(profile, 'paper.restored', () => null)
    ctx.body = { paper, snapshot, mtimeMs: paper.updatedAt }
  } catch (error: any) {
    const code = error?.code || error?.message || ''
    if (code === 'conflict') {
      ctx.status = 409
      ctx.body = { error: '源码已被其他改动更新', code: 'conflict', currentMtimeMs: error?.currentMtimeMs ?? null }
      return
    }
    if (code === 'paper_not_found') return fail(ctx, 409, '还没有 main.tex 可回滚', 'paper_not_found')
    if (code === 'file_too_large') return fail(ctx, 413, '源码过大', 'file_too_large')
    return fail(ctx, 500, error?.message || '回滚失败')
  }
}

/* ------------------------------------------------------------------- deck */

/**
 * POST /api/studio/research/projects/:id/decks
 * body: { title?, progress?, paperIds?, audience? }
 *
 * The host writes the scaffold file so `state.json` and the disk agree; the
 * narrative slots stay `待补` until the agent edits the .md in place.
 */
export async function createDeck(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const profile = profileOf(ctx)
  const paperIds = Array.isArray(body.paperIds)
    ? body.paperIds.filter((item): item is string => typeof item === 'string').slice(0, 40)
    : []
  try {
    const built = await buildDeck(projectId, {
      title: cleanString(body.title).trim(),
      progress: typeof body.progress === 'string' ? body.progress.slice(0, 4000) : '',
      paperIds,
      audience: cleanString(body.audience).trim(),
    }, profile)
    const deck = await updateStore(profile, 'decks.created', store => {
      store.decks.unshift(built.deck)
      store.decks = store.decks.slice(0, 100)
      return built.deck
    })
    ctx.body = { deck, path: built.path, markdown: built.markdown }
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    if (code === 'project_not_found') return fail(ctx, 404, 'Project not found', 'not_found')
    // Another process (the agent) is mid-write; the lock gives up after ~8s.
    // research_locked is mapped to 503 by the bootstrap error middleware.
    if (code === 'research_locked') throw error
    return fail(ctx, 500, code || '生成失败')
  }
}

// GET /api/studio/research/projects/:id/decks/:deckId/file
export async function downloadDeck(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const deckId = String(ctx.params.deckId || '')
  try {
    const { bytes, file } = await readDeckBytes(projectId, deckId, profileOf(ctx))
    const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ctx.set('Content-Type', file.toLowerCase().endsWith('.pptx') ? pptx : 'text/markdown; charset=utf-8')
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file)}"`)
    ctx.body = bytes
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'deck_not_found') return fail(ctx, 404, '找不到汇报', 'not_found')
    if (code === 'invalid_project_id' || code === 'deck_path_invalid') return fail(ctx, 400, '路径非法', 'invalid_path')
    return fail(ctx, 500, code || '下载失败')
  }
}

// GET /api/studio/research/projects/:id/decks
export async function listDecksHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  try {
    ctx.body = { decks: await listDecks(projectId, profileOf(ctx)) }
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    return fail(ctx, 500, code || '读取失败')
  }
}

// GET /api/studio/research/projects/:id/pdf
export async function getPaperPdf(ctx: any) {
  const projectId = String(ctx.params.id || '')
  try {
    const { stream, size, updatedAt } = await openPaperPdf(projectId, profileOf(ctx))
    ctx.type = 'pdf'
    ctx.set('Content-Length', String(size))
    ctx.set('Cache-Control', 'no-store')
    ctx.set('Last-Modified', new Date(updatedAt).toUTCString())
    ctx.body = stream
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    if (code === 'pdf_not_found') return fail(ctx, 404, '还没有 PDF 产物', 'not_found')
    return fail(ctx, 500, code || '读取 PDF 失败')
  }
}

// GET /api/studio/research/paper-pdf?arxivId=...
// 一条文献记录抓下来的 PDF 字节，给面板的阅读器 iframe 用。走 query 而不是
// path，是因为旧式 arXiv id 自带斜杠（hep-th/9901001），塞进路径段会被拆开。
export async function getPaperFilePdf(ctx: any) {
  const arxivId = String(ctx.query.arxivId || '')
  try {
    const { bytes, file } = await readPaperPdfFile(profileOf(ctx), arxivId)
    ctx.set('Content-Type', 'application/pdf')
    ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(file)}"`)
    ctx.set('Content-Length', String(bytes.length))
    ctx.set('Cache-Control', 'private, max-age=0, must-revalidate')
    ctx.body = bytes
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'paper_not_found') return fail(ctx, 404, '找不到这篇文献', 'not_found')
    if (code === 'pdf_not_found') return fail(ctx, 404, '这篇还没有抓取 PDF', 'pdf_not_found')
    if (code === 'pdf_path_invalid' || code === 'arxiv_id_empty') return fail(ctx, 400, 'PDF 路径非法', 'invalid_path')
    if (code === 'ENOENT') return fail(ctx, 404, 'PDF 文件已不在磁盘上', 'pdf_missing')
    return fail(ctx, 500, code || '读取 PDF 失败')
  }
}

// GET /api/studio/research/projects/:id/decks/:deckId/preview
export async function previewDeck(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const deckId = String(ctx.params.deckId || '')
  try {
    ctx.body = await buildDeckPreview(projectId, deckId, profileOf(ctx))
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'deck_not_found') return fail(ctx, 404, '找不到汇报', 'not_found')
    if (code === 'invalid_project_id' || code === 'deck_path_invalid') return fail(ctx, 400, '路径非法', 'invalid_path')
    if (code === 'deck_preview_unreadable') return fail(ctx, 422, '这份汇报解析不出页面', 'unreadable')
    return fail(ctx, 500, code || '预览失败')
  }
}

// GET /api/studio/research/projects/:id/decks/:deckId
export async function getDeck(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const deckId = String(ctx.params.deckId || '')
  try {
    ctx.body = await readDeck(projectId, deckId, profileOf(ctx))
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 非法', 'invalid_path')
    if (code === 'deck_not_found') return fail(ctx, 404, 'Deck not found', 'not_found')
    if (code === 'deck_path_invalid') return fail(ctx, 400, '汇报文件路径非法', 'invalid_path')
    return fail(ctx, 500, code || '读取失败')
  }
}

// GET /api/studio/research/projects/:id/compile/status
export async function compileStatus(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  ctx.body = {
    status: await readCompileStatus(projectId, profile),
    last: await readLastCompile(projectId, profile),
  }
}

/** Match a figure record by its absolute path, a suffix of it, or its file name. */
function matchFigure(store: any, projectId: string, relPath: string): any {
  const name = relPath.split(/[\\/]/).pop() || ''
  return store.figures.find((item: any) => item.projectId === projectId
    && (item.path === relPath || String(item.path).endsWith(relPath) || item.name === name))
}

const FIGURE_UPLOAD_LIMIT = 32 * 1024 * 1024

// POST /api/studio/research/projects/:id/figures/upload?name=&dir=
export async function uploadFigureHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const name = cleanString(ctx.query.name).trim()
  const dir = cleanString(ctx.query.dir).trim()
  if (name === '') return fail(ctx, 400, '缺少文件名')
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of ctx.req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > FIGURE_UPLOAD_LIMIT) return fail(ctx, 413, '图片超过 32MB', 'too_large')
      chunks.push(buf)
    }
  } catch {
    return fail(ctx, 400, '读取上传数据失败')
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.length === 0) return fail(ctx, 400, '空文件')
  const profile = profileOf(ctx)
  try {
    const saved = await saveProjectFigure(projectId, dir, name, bytes, profile)
    const figure = await updateStore(profile, 'figures.uploaded', draft => {
      const existing = draft.figures.find(item => item.projectId === projectId && item.path === saved.path)
      if (existing) {
        existing.at = Date.now()
        existing.origin = 'manual'
        return existing
      }
      const row = {
        id: newId('figure'),
        projectId,
        name,
        path: saved.path,
        caption: '',
        insertedInto: '',
        origin: 'manual' as const,
        at: Date.now(),
      }
      draft.figures.unshift(row)
      return row
    })
    ctx.body = { figure, relPath: saved.relPath }
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id' || code === 'invalid_figure_path' || code === 'invalid_figure_name') {
      return fail(ctx, 400, '图片路径非法', 'invalid_path')
    }
    return fail(ctx, 500, code || '上传失败')
  }
}

// POST /api/studio/research/projects/:id/figures/rename
export async function renameFigureHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const relPath = cleanString(body.path).trim()
  const newName = cleanString(body.name).trim()
  if (relPath === '' || newName === '') return fail(ctx, 400, '缺少 path/name')
  const profile = profileOf(ctx)
  try {
    const moved = await renameProjectFigure(projectId, relPath, newName, profile)
    const store = await readStore(profile)
    const figure = matchFigure(store, projectId, relPath)
    if (figure) {
      await updateStore(profile, 'figures.renamed', draft => {
        const row = draft.figures.find(item => item.id === figure.id)
        if (row) {
          row.name = newName
          row.path = moved.newPath
        }
        return row
      })
    }
    ctx.body = { path: moved.newPath, name: newName, id: figure ? figure.id : null }
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id' || code === 'invalid_figure_path' || code === 'invalid_figure_name') {
      return fail(ctx, 400, '图片路径非法', 'invalid_path')
    }
    if (code === 'figure_not_found') return fail(ctx, 404, '图片不存在', 'not_found')
    if (code === 'figure_exists') return fail(ctx, 409, '同名图片已存在', 'conflict')
    return fail(ctx, 500, code || '重命名失败')
  }
}

// POST /api/studio/research/projects/:id/figures/convert
/** Produce the LaTeX-embeddable sibling of one figure (SVG → PDF). */
export async function convertFigureHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const relPath = cleanString(body.path).trim()
  if (relPath === '') return fail(ctx, 400, '缺少 path')
  const profile = profileOf(ctx)
  try {
    ctx.body = await convertProjectFigure(projectId, relPath, profile)
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id' || code === 'invalid_figure_path') {
      return fail(ctx, 400, '图片路径非法', 'invalid_path')
    }
    if (code === 'figure_not_found') return fail(ctx, 404, '图片不存在', 'not_found')
    if (code === 'unsupported_figure_type') return fail(ctx, 415, '这种图片格式不需要转换', 'unsupported_type')
    if (code === 'no_converter') {
      return fail(ctx, 501, '这台机器上没有 SVG→PDF 转换器（rsvg-convert）', 'no_converter')
    }
    return fail(ctx, 500, code || '转换失败')
  }
}

// DELETE /api/studio/research/projects/:id/figure?path=
export async function deleteFigureHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const relPath = String(ctx.query.path || '').trim()
  if (relPath === '') return fail(ctx, 400, '缺少 path')
  const profile = profileOf(ctx)
  try {
    await deleteProjectFigure(projectId, relPath, profile)
    const store = await readStore(profile)
    const figure = matchFigure(store, projectId, relPath)
    if (figure) {
      await updateStore(profile, 'figures.deleted', draft => {
        draft.figures = draft.figures.filter(item => item.id !== figure.id)
        return true
      })
    }
    ctx.body = { ok: true, id: figure ? figure.id : null }
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_project_id' || code === 'invalid_figure_path') {
      return fail(ctx, 400, '图片路径非法', 'invalid_path')
    }
    return fail(ctx, 500, code || '删除失败')
  }
}

// GET /api/studio/research/projects/:id/artifact?name=EXPERIMENT_LOG.md
export async function readArtifactHandler(ctx: any) {
  const name = typeof ctx.query.name === 'string' ? ctx.query.name : 'EXPERIMENT_LOG.md'
  ctx.body = await readArtifactView(profileOf(ctx), String(ctx.params.id), name)
}

// GET /api/studio/research/ledger/worktree
export async function ledgerWorktree(ctx: any) {
  ctx.body = { worktree: await worktreeView(profileOf(ctx)) }
}

// GET /api/studio/research/ledger/foraging
export async function ledgerForaging(ctx: any) {
  ctx.body = { foraging: await foragingView(profileOf(ctx)) }
}

// GET /api/studio/research/ledger/moments
export async function ledgerMoments(ctx: any) {
  ctx.body = await momentIndexView(profileOf(ctx))
}

// GET /api/studio/research/ledger/evidence
export async function ledgerEvidence(ctx: any) {
  ctx.body = await evidenceGraphView(profileOf(ctx))
}

// GET /api/studio/research/ledger/digest
export async function ledgerDigest(ctx: any) {
  ctx.body = await digestView(profileOf(ctx), {
    tier: ctx.query.tier,
    since: ctx.query.since,
    until: ctx.query.until,
    lang: ctx.query.lang,
  })
}

// POST /api/studio/research/wiki/import
export async function importWikiHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const snapshot = body.snapshot as Record<string, unknown> | undefined
  if (!snapshot || snapshot.format !== 'mimir-wiki') return fail(ctx, 400, '快照格式非法', 'invalid_snapshot')
  const tables = snapshot.tables as Record<string, unknown> | undefined
  if (!tables || typeof tables !== 'object') return fail(ctx, 400, '快照缺少 tables', 'invalid_snapshot')
  const mode = body.mode === 'replace' ? 'replace' : 'merge'
  if (mode === 'replace' && body.confirmReplace !== true) {
    return fail(ctx, 400, 'replace 需要 confirmReplace', 'confirm_required')
  }
  const mapping: Array<[string, string]> = [
    ['papers', 'papers'],
    ['ideas', 'ideas'],
    ['projects', 'projects'],
    ['experiments', 'experiments'],
    ['servers', 'servers'],
  ]
  const profile = profileOf(ctx)
  try {
    const counts = await updateStore(profile, 'wiki.imported', draft => {
      const imported: Record<string, number> = {}
      const skipped: Record<string, number> = {}
      if (mode === 'replace') {
        for (const [, collection] of mapping) {
          if (collection === 'projects') draft.projects = []
          else (draft as unknown as Record<string, unknown[]>)[collection] = []
        }
      }
      for (const [table, collection] of mapping) {
        const rows = Array.isArray(tables[table]) ? (tables[table] as unknown[]) : []
        imported[table] = 0
        skipped[table] = 0
        const list = (collection === 'projects'
          ? draft.projects
          : (draft as unknown as Record<string, unknown[]>)[collection]) as unknown as Array<Record<string, unknown>>
        for (const row of rows) {
          if (!row || typeof row !== 'object') {
            skipped[table] += 1
            continue
          }
          const item = row as Record<string, unknown>
          const id = typeof item.id === 'string' ? item.id : ''
          if (id === '') {
            skipped[table] += 1
            continue
          }
          if (list.some(existing => existing.id === id)) {
            skipped[table] += 1
            continue
          }
          list.push(item)
          imported[table] += 1
        }
      }
      return { imported, skipped }
    })
    ctx.body = counts
  } catch (error: any) {
    return fail(ctx, 500, error?.message || '导入失败')
  }
}

// POST /api/studio/research/worktree/mainline
export async function setMainlineHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const projectId = cleanString(body.projectId).trim()
  const ideaId = cleanString(body.ideaId).trim()
  if (projectId === '' && ideaId === '') return fail(ctx, 400, '缺少主线目标')
  const lineId = projectId !== '' ? `project:${projectId}` : `idea:${ideaId}`
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const known = projectId !== ''
    ? store.projects.some(item => item.id === projectId)
    : store.ideas.some(item => item.id === ideaId)
  if (!known) return fail(ctx, 404, '找不到这条线', 'not_found')
  const ref = await updateStore(profile, 'worktree.mainline', draft => {
    const declared = { lineId, declaredAt: Date.now() }
    draft.mainline = declared
    draft.mainlineHistory = [declared, ...(draft.mainlineHistory ?? [])].slice(0, 50)
    return declared
  })
  ctx.body = { mainline: ref }
}

// POST /api/studio/research/worktree/idea-parent
export async function setIdeaParentHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const ideaId = cleanString(body.ideaId).trim()
  const parentIdeaId = cleanString(body.parentIdeaId).trim()
  if (ideaId === '') return fail(ctx, 400, '缺少 ideaId')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  if (!store.ideas.some(item => item.id === ideaId)) return fail(ctx, 404, '找不到这条线', 'not_found')
  if (parentIdeaId !== '' && !store.ideas.some(item => item.id === parentIdeaId)) {
    return fail(ctx, 404, '找不到父线', 'not_found')
  }
  if (parentIdeaId === ideaId) return fail(ctx, 400, '不能把一条线挂到自己下面', 'invalid_request')
  const row = await updateStore(profile, 'worktree.idea-parent', draft => {
    const idea = draft.ideas.find(item => item.id === ideaId)
    if (idea) idea.parentId = parentIdeaId
    return idea ?? null
  })
  ctx.body = { idea: row }
}

// POST /api/studio/research/worktree/adopt
export async function adoptIdeaHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const ideaId = cleanString(body.ideaId).trim()
  if (ideaId === '') return fail(ctx, 400, '缺少 ideaId')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  if (!store.ideas.some(item => item.id === ideaId)) return fail(ctx, 404, '找不到这条线', 'not_found')
  const row = await updateStore(profile, 'worktree.adopted', draft => {
    const idea = draft.ideas.find(item => item.id === ideaId)
    if (idea && idea.kind === 'idea') idea.kind = 'decision'
    return idea ?? null
  })
  ctx.body = { idea: row }
}

// POST /api/studio/research/worktree/close
export async function closeIdeaHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const ideaId = cleanString(body.ideaId).trim()
  const reason = cleanString(body.reason).trim()
  if (ideaId === '') return fail(ctx, 400, '缺少 ideaId')
  if (reason === '') return fail(ctx, 400, '关闭理由不能为空')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  if (!store.ideas.some(item => item.id === ideaId)) return fail(ctx, 404, '找不到这条线', 'not_found')
  const row = await updateStore(profile, 'worktree.closed', draft => {
    const idea = draft.ideas.find(item => item.id === ideaId)
    if (idea) {
      idea.closedAt = Date.now()
      idea.closeReason = reason.slice(0, 500)
    }
    return idea ?? null
  })
  ctx.body = { idea: row }
}

// GET /api/studio/research/ledger/events
export async function ledgerEvents(ctx: any) {
  const limit = Math.min(Math.max(Number(ctx.query.limit) || 200, 1), 500)
  const projectId = String(ctx.query.projectId || '').trim()
  let rows = await readChangeLog(profileOf(ctx), limit, projectId)
  const since = Date.parse(String(ctx.query.since || ''))
  const until = Date.parse(String(ctx.query.until || ''))
  if (!Number.isNaN(since)) rows = rows.filter(row => row.at >= since)
  if (!Number.isNaN(until)) rows = rows.filter(row => row.at < until)
  if (String(ctx.query.order || 'desc') === 'desc') rows = rows.slice().reverse()
  ctx.body = { events: rows.slice(0, limit) }
}

// GET /api/studio/research/zotero/status
export async function zoteroStatus(ctx: any) {
  ctx.body = await probeZotero(profileOf(ctx))
}

/** Zotero 的失败一律翻译成一个稳定的 HTTP 状态 + 可展示的中文原因。 */
function zoteroFail(ctx: any, error: any) {
  const code = error?.message || ''
  if (code === 'zotero_unconfigured') {
    return fail(ctx, 400, 'Zotero 还没配置：在 <研究根目录>/zotero.json 写入 apiKey 与 userId（或设 ZOTERO_API_KEY / ZOTERO_USER_ID）', 'unconfigured')
  }
  if (code === 'zotero_query_empty') return fail(ctx, 400, '检索词不能为空')
  if (code === 'zotero_bad_limit') return fail(ctx, 400, '结果条数必须是 1..50 的整数')
  if (code === 'zotero_key_empty') return fail(ctx, 400, '缺少 itemKey')
  if (code === 'zotero_collection_empty') return fail(ctx, 400, '缺少 collectionKey')
  if (code === 'zotero_item_not_reference') return fail(ctx, 404, '这个 key 不是文献条目（可能是附件或笔记）', 'not_found')
  if (code === 'zotero_item_no_title') return fail(ctx, 400, '这条 Zotero 记录没有标题')
  if (code === 'project_not_found') return fail(ctx, 404, '项目不存在', 'not_found')
  if (code.startsWith('HTTP ')) return fail(ctx, 502, `Zotero 返回 ${code}`, 'upstream_failed')
  if (code === 'figure_exists') return fail(ctx, 409, '同名条目已存在', 'conflict')
  return fail(ctx, 502, `Zotero 请求失败：${code || '未知原因'}`, 'upstream_failed')
}

// GET /api/studio/research/zotero/collections
export async function zoteroCollections(ctx: any) {
  try {
    ctx.body = { collections: await listZoteroCollections(profileOf(ctx)) }
  } catch (error: any) {
    zoteroFail(ctx, error)
  }
}

// GET /api/studio/research/zotero/items?query=&max=
export async function zoteroItems(ctx: any) {
  const query = String(ctx.query?.query || '')
  const max = Number(ctx.query?.max)
  try {
    ctx.body = {
      results: await searchZoteroItems(profileOf(ctx), query, Number.isFinite(max) ? max : undefined),
    }
  } catch (error: any) {
    zoteroFail(ctx, error)
  }
}

// POST /api/studio/research/projects/:id/papers/import-zotero  body: { key }
export async function importZoteroPaper(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const key = cleanString(body.key).trim()
  if (key === '') return fail(ctx, 400, '缺少 key')
  try {
    ctx.body = await importZoteroItem(profileOf(ctx), key, projectId)
  } catch (error: any) {
    zoteroFail(ctx, error)
  }
}

// POST /api/studio/research/projects/:id/bibliography/import-zotero  body: { collectionKey }
export async function importZoteroCollectionBib(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const collectionKey = cleanString(body.collectionKey).trim()
  if (collectionKey === '') return fail(ctx, 400, '缺少 collectionKey')
  try {
    ctx.body = await exportZoteroCollectionToBib(profileOf(ctx), projectId, collectionKey)
  } catch (error: any) {
    zoteroFail(ctx, error)
  }
}

/* --------------------------------------------------------------- 设置 */

// GET /api/studio/research/settings/image-gen
export async function imageGenConfigGet(ctx: any) {
  ctx.body = await getImageGenConfig(profileOf(ctx))
}

// POST /api/studio/research/settings/image-gen  body: { baseUrl?, apiKey?, model?, size? }
export async function imageGenConfigSet(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const patch: { baseUrl?: string; apiKey?: string; model?: string; size?: string } = {}
  for (const key of ['baseUrl', 'apiKey', 'model', 'size'] as const) {
    if (body[key] === undefined) continue
    patch[key] = cleanString(body[key]).trim()
  }
  try {
    ctx.body = await setImageGenConfig(profileOf(ctx), patch)
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'image_gen_bad_base_url') return fail(ctx, 400, 'baseUrl 必须是 http(s) 地址')
    return fail(ctx, 500, code || '保存失败')
  }
}

// GET /api/studio/research/settings/sxng
export async function sxngConfigGet(ctx: any) {
  ctx.body = await getSxngConfig(profileOf(ctx))
}

// POST /api/studio/research/settings/sxng  body: 各字段可选
export async function sxngConfigSet(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const patch: Record<string, unknown> = {}
  for (const key of ['baseUrl', 'defaultEngine', 'proxyUrl', 'ollamaApiKey'] as const) {
    if (body[key] !== undefined) patch[key] = cleanString(body[key]).trim()
  }
  if (Array.isArray(body.allowedEngines)) {
    patch.allowedEngines = body.allowedEngines
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 50)
  }
  for (const key of ['defaultLimit', 'timeout', 'redundancyThreshold', 'redundancyBigramThreshold'] as const) {
    if (typeof body[key] === 'number') patch[key] = body[key]
  }
  if (typeof body.useProxy === 'boolean') patch.useProxy = body.useProxy
  if (body.defaultFormat === 'md' || body.defaultFormat === 'json') patch.defaultFormat = body.defaultFormat
  try {
    ctx.body = await setSxngConfig(profileOf(ctx), patch as Parameters<typeof setSxngConfig>[1])
  } catch (error: any) {
    const code = error?.message || ''
    const known: Record<string, string> = {
      sxng_bad_base_url: 'baseUrl 必须是 http(s) 地址',
      sxng_bad_proxy_url: 'proxyUrl 必须是 http(s) 地址',
      sxng_bad_limit: '默认条数必须是正整数',
      sxng_bad_timeout: 'timeout 至少要 1000 毫秒',
      sxng_bad_threshold: '冗余阈值必须在 0 到 1 之间',
    }
    if (known[code] !== undefined) return fail(ctx, 400, known[code])
    return fail(ctx, 500, code || '保存失败')
  }
}

/**
 * GET /api/studio/research/web/search?query=&max=&categories=&lang=
 *
 * The panel's web search runs against the SearXNG instance named in the sxng
 * settings; nothing is cached, so every call is a live fetch.
 */
export async function webSearchHandler(ctx: any) {
  const query = String(ctx.query?.query || '')
  const max = Number(ctx.query?.max)
  const categories = typeof ctx.query?.categories === 'string' ? ctx.query.categories : undefined
  const lang = typeof ctx.query?.lang === 'string' ? ctx.query.lang : undefined
  try {
    ctx.body = {
      results: await searchWeb(profileOf(ctx), {
        query,
        ...(Number.isFinite(max) ? { maxResults: max } : {}),
        ...(categories === undefined ? {} : { categories }),
        ...(lang === undefined ? {} : { lang }),
      }),
    }
  } catch (error: any) {
    const code = error?.message || ''
    const known: Record<string, string> = {
      web_query_empty: '检索词不能为空',
      web_bad_limit: '结果条数必须是 1..50 的整数',
      sxng_unconfigured: '还没配置搜索实例：在研究设置里填 sxng 的 baseUrl',
      sxng_bad_response: '搜索实例没有返回 JSON（需要在 SearXNG 里开启 json 格式）',
    }
    if (known[code] !== undefined) return fail(ctx, 400, known[code], code)
    if (code.startsWith('sxng_unreachable')) return fail(ctx, 502, `连不上搜索实例：${code.slice('sxng_unreachable:'.length).trim()}`, 'upstream_failed')
    if (code.startsWith('sxng_http_')) return fail(ctx, 502, `搜索实例返回 ${code.slice('sxng_http_'.length)}`, 'upstream_failed')
    return fail(ctx, 500, code || '检索失败')
  }
}

/* ------------------------------------------------- 期刊条目 / 证据边 */

// POST /api/studio/research/journal  body: { text, projectId?, ideaId?, valence?, arousal?, question? }
export async function addJournalEntryHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const question = body.question !== null && typeof body.question === 'object'
    ? {
      kind: cleanString((body.question as Record<string, unknown>).kind).trim(),
      lineId: cleanString((body.question as Record<string, unknown>).lineId).trim(),
    }
    : undefined
  try {
    ctx.body = await addJournalEntry(profileOf(ctx), {
      text: cleanString(body.text),
      ...(cleanString(body.projectId).trim() === '' ? {} : { projectId: cleanString(body.projectId).trim() }),
      ...(cleanString(body.ideaId).trim() === '' ? {} : { ideaId: cleanString(body.ideaId).trim() }),
      ...(typeof body.valence === 'number' ? { valence: body.valence } : {}),
      ...(typeof body.arousal === 'number' ? { arousal: body.arousal } : {}),
      ...(question === undefined || question.kind === '' ? {} : { question }),
    })
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'journal_text_empty') return fail(ctx, 400, '这一条不能是空的')
    if (code === 'journal_text_too_long') return fail(ctx, 400, '这一条太长了（上限 4000 字）')
    if (code === 'project_not_found') return fail(ctx, 404, '项目不存在', 'not_found')
    return fail(ctx, 500, code || '写入失败')
  }
}

// POST /api/studio/research/evidence/edges  body: AddEvidenceEdgeRequest
export async function addEvidenceEdgeHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const srcLabel = cleanString(body.srcLabel).trim()
  const dstLabel = cleanString(body.dstLabel).trim()
  try {
    ctx.body = await addEvidenceEdge(profileOf(ctx), {
      rel: cleanString(body.rel),
      src: cleanString(body.src),
      dst: cleanString(body.dst),
      ...(srcLabel === '' ? {} : { srcLabel }),
      ...(dstLabel === '' ? {} : { dstLabel }),
      note: cleanString(body.note),
      projectId: cleanString(body.projectId),
      ideaId: cleanString(body.ideaId),
      claimId: cleanString(body.claimId),
    })
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'edge_bad_rel') return fail(ctx, 400, '未知的关系类型')
    if (code === 'edge_bad_endpoints') return fail(ctx, 400, 'src / dst 不能为空')
    if (code === 'edge_key_too_long') return fail(ctx, 400, '端点键超过 128 字符')
    return fail(ctx, 500, code || '写入失败')
  }
}

// POST /api/studio/research/evidence/edges/retract  body: RetractEvidenceEdgeRequest
export async function retractEvidenceEdgeHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = await retractEvidenceEdge(profileOf(ctx), {
      dedupKey: cleanString(body.dedupKey),
      reason: cleanString(body.reason),
    })
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'edge_dedup_key_empty') return fail(ctx, 400, '缺少 dedupKey')
    if (code === 'edge_not_found') return fail(ctx, 404, '这条证据边不存在', 'not_found')
    if (code === 'edge_already_retracted') return fail(ctx, 409, '这条证据边已经撤回过了', 'conflict')
    return fail(ctx, 500, code || '撤回失败')
  }
}

/* ------------------------------------------------------ 文献 PDF / 导入 */

// POST /api/studio/research/projects/:id/papers/fetch-pdf  body: { arxivId }
export async function fetchPaperPdfHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const arxivId = cleanString(body.arxivId).trim()
  if (arxivId === '') return fail(ctx, 400, '缺少 arxivId')
  try {
    const paper = await fetchPaperPdf(profileOf(ctx), projectId, arxivId)
    ctx.body = { paper }
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'arxiv_id_invalid') return fail(ctx, 400, 'arXiv id 格式不对')
    if (code === 'paper_not_found') return fail(ctx, 404, '项目里没有这篇论文', 'not_found')
    if (code.startsWith('arxiv_unreachable')) return fail(ctx, 502, `连不上 arXiv：${code.slice('arxiv_unreachable:'.length).trim()}`, 'upstream_failed')
    if (code.startsWith('arxiv_http_')) return fail(ctx, 502, `arXiv 返回 ${code.slice('arxiv_http_'.length)}`, 'upstream_failed')
    if (code === 'arxiv_not_pdf') return fail(ctx, 502, 'arXiv 回来的不是 PDF（可能是 id 无效）', 'upstream_failed')
    if (code === 'arxiv_too_large') return fail(ctx, 413, 'PDF 超过 80MB，已拒绝', 'too_large')
    return fail(ctx, 500, code || '抓取失败')
  }
}

// POST /api/studio/research/projects/import  body: { path, title? }
export async function importProjectHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = await importProject(profileOf(ctx), {
      path: cleanString(body.path),
      ...(cleanString(body.title).trim() === '' ? {} : { title: cleanString(body.title).trim() }),
    })
  } catch (error: any) {
    const code = error?.message || ''
    const known: Record<string, string> = {
      import_path_empty: '请填源目录路径',
      import_path_missing: '这个路径不存在',
      import_path_not_dir: '这个路径不是目录',
      import_empty_dir: '源目录是空的',
      import_no_tex: '源目录里没有 .tex 文件',
      import_no_entry: '没找到带 \\documentclass 的 .tex（不知道从哪份开始编译）',
      import_too_large: '源目录太大（上限 200MB / 3000 个文件）',
    }
    if (known[code] !== undefined) return fail(ctx, 400, known[code])
    return fail(ctx, 500, code || '导入失败')
  }
}

// POST /api/studio/research/projects/:id/compile
export async function compileProject(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  const result = await runCompile(projectId, profile)
  await updateStore(profile, 'paper.compiled', () => null)
  if (result.ok) await captureSnapshot(projectId, profile)
  ctx.body = { result, status: await readCompileStatus(projectId, profile) }
}

/* -------------------------------------------------------------------- ssh */

// POST /api/studio/research/items/servers/:id/check
export async function checkServer(ctx: any) {
  const id = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const server = store.servers.find(item => item.id === id)
  if (!server) return fail(ctx, 404, 'Server not found', 'not_found')

  const probe = await probeServer({ host: server.host, user: server.user, port: server.port })
  const updated = await updateStore(profile, 'servers.checked', working => {
    const target = working.servers.find(item => item.id === id)
    if (!target) return null
    target.status = probe.status
    target.lastCheckedAt = probe.at
    target.note = probe.detail.slice(0, 4000)
    return target
  })
  ctx.body = { probe, server: updated }
}

// POST /api/studio/research/items/servers/:id/jobs  body: { name, command }
export async function submitServerJob(ctx: any) {
  const id = String(ctx.params.id || '')
  const body = readBody(ctx)
  const name = cleanString(body?.name).trim() || 'job'
  const command = cleanString(body?.command).trim()
  if (!command) return fail(ctx, 400, '缺少要执行的命令')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const server = store.servers.find(item => item.id === id)
  if (!server) return fail(ctx, 404, 'Server not found', 'not_found')

  const submitted = await submitJob({ host: server.host, user: server.user, port: server.port }, name, command)
  const job = await updateStore(profile, 'jobs.submitted', working => {
    const record = {
      id: newId('job'),
      projectId: server.projectId,
      serverId: id,
      name,
      command,
      state: (submitted.ok ? 'running' : 'failed') as 'running' | 'failed',
      submittedAt: Date.now(),
      endedAt: submitted.ok ? 0 : Date.now(),
      logPath: submitted.logPath,
      exitCode: submitted.ok ? null : -1,
      pid: submitted.pid,
      note: submitted.detail,
    }
    working.jobs.unshift(record)
    return record
  })
  ctx.body = { job, submitted }
}

// POST /api/studio/research/items/jobs/:id/refresh
export async function refreshJob(ctx: any) {
  const id = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const job = store.jobs.find(item => item.id === id)
  if (!job) return fail(ctx, 404, 'Job not found', 'not_found')
  const server = store.servers.find(item => item.id === job.serverId)
  if (!server) return fail(ctx, 404, 'Server not found', 'not_found')

  const state = await jobState({ host: server.host, user: server.user, port: server.port }, job.pid || '', job.logPath)
  const updated = await updateStore(profile, 'jobs.refreshed', working => {
    const target = working.jobs.find(item => item.id === id)
    if (!target) return null
    target.state = state.state
    target.note = state.detail
    if (state.state !== 'running') {
      target.endedAt = Date.now()
      target.exitCode = state.exitCode
    }
    return target
  })
  ctx.body = { job: updated, state }
}

/* ----------------------------------------------------------------- venues */

// POST /api/studio/research/moments/pin
export async function pinMomentHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const targetEventId = cleanString(body.targetEventId).trim()
  if (targetEventId === '') return fail(ctx, 400, '缺少 targetEventId')
  const pinned = body.pinned !== false
  const note = cleanString(body.note).trim().slice(0, 200)
  const profile = profileOf(ctx)
  const row = await updateStore(profile, pinned ? 'moment.pinned' : 'moment.declined', draft => {
    draft.momentMarks = draft.momentMarks ?? []
    const existing = draft.momentMarks.find(item => item.targetEventId === targetEventId)
    if (existing) {
      existing.pinned = pinned
      existing.note = note
      existing.at = Date.now()
      return existing
    }
    const created = { targetEventId, pinned, note, at: Date.now() }
    draft.momentMarks.unshift(created)
    return created
  })
  ctx.body = { mark: row }
}

// POST /api/studio/research/eureka
export async function setEurekaHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const title = cleanString(body.title).trim()
  if (title === '') return fail(ctx, 400, '顿悟标题不能为空')
  const ideaId = cleanString(body.ideaId).trim()
  const projectId = cleanString(body.projectId).trim()
  const profile = profileOf(ctx)
  const declaration = await updateStore(profile, 'eureka.declared', draft => {
    draft.eurekas = draft.eurekas ?? []
    const created = {
      id: newId('eureka'),
      title: title.slice(0, 200),
      ideaId: ideaId === '' ? null : ideaId,
      projectId: projectId === '' ? null : projectId,
      at: Date.now(),
    }
    draft.eurekas.unshift(created)
    return created
  })
  ctx.body = { eureka: declaration }
}

// GET /api/studio/research/eureka
export async function eurekaView(ctx: any) {
  const store = await readStore(profileOf(ctx))
  const declarations = (store.eurekas ?? []).map(item => ({
    id: item.id,
    title: item.title,
    // 证据图的布局层按 lineId 分带，缺这个字段会在 bandKeyOfLine 里炸掉整页。
    lineId: item.projectId !== null && item.projectId !== ''
      ? `project:${item.projectId}`
      : (item.ideaId !== null && item.ideaId !== '' ? `idea:${item.ideaId}` : null),
    ideaId: item.ideaId,
    projectId: item.projectId,
    at: new Date(item.at).toISOString(),
  }))
  ctx.body = { derivedAt: new Date().toISOString(), declarations }
}

// GET /api/studio/research/venue-templates
export async function venueTemplatesHandler(ctx: any) {
  try {
    const catalog = await loadVenueCatalog(profileOf(ctx))
    const templates = catalog.items
      .filter(item => item.ccf === 'A')
      .map(item => ({ id: item.key, name: item.name, series: item.field || 'CCF-A', url: item.link }))
    ctx.body = { templates, stale: catalog.stale, error: catalog.error }
  } catch (error: any) {
    return fail(ctx, 500, error?.message || '读取会议模板失败')
  }
}

// POST /api/studio/research/projects/:id/venue-template
export async function applyVenueTemplateHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  const templateId = cleanString(body.templateId).trim()
  const customName = cleanString(body.customName).trim()
  if (templateId === '' && customName === '') return fail(ctx, 400, '缺少 templateId/customName')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const project = store.projects.find(item => item.id === projectId)
  if (!project) return fail(ctx, 404, '找不到项目', 'not_found')
  let venue: ResearchVenueRef
  if (templateId !== '') {
    let catalog
    try {
      catalog = await loadVenueCatalog(profile)
    } catch {
      return fail(ctx, 502, '会议目录不可用，稍后重试', 'venue_catalog_unavailable')
    }
    const item = catalog.items.find(entry => entry.key === templateId)
    if (!item) return fail(ctx, 404, '模板不存在', 'not_found')
    venue = { id: item.key, name: item.name, series: item.field || 'CCF-A', url: item.link }
  } else {
    venue = { id: `custom:${customName.slice(0, 40)}`, name: customName.slice(0, 80), series: '自定义', url: '' }
  }
  await updateStore(profile, 'project.venue', draft => {
    const row = draft.projects.find(item => item.id === projectId)
    if (row) {
      row.venue = venue
      row.updatedAt = Date.now()
    }
    return row ?? null
  })
  // ekko has no .cls assets: record the target venue, never rewrite \documentclass
  // to a class file the user does not have (that would break the compile).
  ctx.body = {
    venue,
    warnings: ['已记录目标会议/期刊；ekko 未内置 LaTeX 模板类，请手动套用官方样式文件'],
  }
}

// DELETE /api/studio/research/projects/:id/venue-template
export async function clearVenueTemplateHandler(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const profile = profileOf(ctx)
  const store = await readStore(profile)
  if (!store.projects.some(item => item.id === projectId)) return fail(ctx, 404, '找不到项目', 'not_found')
  await updateStore(profile, 'project.venue.cleared', draft => {
    const row = draft.projects.find(item => item.id === projectId)
    if (row) {
      row.venue = null
      row.updatedAt = Date.now()
    }
    return row ?? null
  })
  ctx.body = { venue: null }
}

// GET /api/studio/research/venues/catalog?q=&ccf=&limit=&force=1
export async function venueCatalog(ctx: any) {
  const force = String(ctx.query?.force || '') === '1'
  const catalog = await loadVenueCatalog(profileOf(ctx), force)
  const items = filterCatalog(catalog.items, {
    query: String(ctx.query?.q || ''),
    ccf: String(ctx.query?.ccf || ''),
    limit: Number(ctx.query?.limit || 40),
  })
  ctx.body = { items, total: catalog.items.length, fetchedAt: catalog.fetchedAt, stale: catalog.stale, error: catalog.error }
}

// GET /api/studio/research/projects/:id/figure?path=figures/foo.png
export async function getProjectFigure(ctx: any) {
  const projectId = String(ctx.params.id || '')
  const relPath = String(ctx.query.path || '')
  try {
    const { bytes, contentType } = await readProjectFigure(projectId, relPath, profileOf(ctx))
    ctx.type = contentType
    ctx.set('Cache-Control', 'no-store')
    ctx.body = bytes
  } catch (error: any) {
    const code = error?.message || ''
    if (code === 'invalid_figure_path') return fail(ctx, 400, '配图路径不合法', 'invalid_path')
    if (code === 'figure_not_found') return fail(ctx, 404, '配图不存在', 'not_found')
    if (code === 'figure_too_large') return fail(ctx, 413, '配图过大', 'too_large')
    if (code === 'unsupported_figure_type') return fail(ctx, 415, '不支持的配图类型', 'unsupported_type')
    if (code === 'invalid_project_id') return fail(ctx, 400, '项目 id 不合法', 'invalid_path')
    return fail(ctx, 500, code || '读取配图失败')
  }
}
