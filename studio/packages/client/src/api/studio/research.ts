import { getApiKey, getBaseUrlValue, getActiveProfileName, request, requestBlob } from '../client'

/**
 * Client mirror of the server's research store.
 *
 * The shapes are duplicated rather than imported: the server package is a
 * separate TS project, and the wire format is the contract between them. Keep
 * both sides in sync when a field is added.
 */
export const RESEARCH_COLLECTIONS = [
  'papers',
  'experiments',
  'figures',
  'ideas',
  'servers',
  'jobs',
  'venues',
  'subscriptions',
  'snapshots',
  'decks',
] as const

export type ResearchCollection = typeof RESEARCH_COLLECTIONS[number]

export interface ResearchProject {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Target venue chosen from the paper header's picker (null until picked). */
  venue?: { id: string; name: string; series: string; url: string } | null
}

export interface ResearchPaper {
  id: string
  projectId: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  arxivId: string
  score: number
  status: 'new' | 'reading' | 'read'
  notes: string
  /** 面板里手动编辑的标签；没有这个字段的记录仍按 venue/year/status 派生显示。 */
  tags?: string[]
  addedAt: number
  /** 已抓取的 PDF 的本地绝对路径，没有抓过就没有这个字段。 */
  pdfPath?: string
}

export interface ResearchMetric {
  name: string
  value: string
  unit: string
  /** 'max' | 'min' — kept as string so a select can bind without narrowing. */
  better: string
}

export interface ResearchExperiment {
  id: string
  projectId: string
  name: string
  config: string
  metrics: ResearchMetric[]
  conclusion: string
  /** 'planned' | 'running' | 'done' | 'failed' — kept as string for form binding. */
  status: string
  at: number
}

export interface ResearchFigure {
  id: string
  projectId: string
  name: string
  path: string
  caption: string
  insertedInto: string
  origin: 'agent' | 'manual'
  at: number
}

export interface ResearchIdea {
  id: string
  projectId: string
  kind: 'idea' | 'decision' | 'result'
  text: string
  at: number
  parentId: string
  /** Set when the user closed this lane with a reason. */
  closedAt?: number
  closeReason?: string
}

export interface ResearchServer {
  id: string
  projectId: string
  host: string
  user: string
  port: number
  status: 'unknown' | 'online' | 'offline'
  lastCheckedAt: number
  note: string
}

export type ResearchJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface ResearchJob {
  id: string
  projectId: string
  serverId: string
  name: string
  command: string
  state: ResearchJobState
  submittedAt: number
  endedAt: number
  logPath: string
  exitCode: number | null
  pid?: string
  note?: string
}

export interface ResearchVenue {
  id: string
  projectId: string
  name: string
  ccf: 'A' | 'B' | 'C' | ''
  deadline: string
  starred: boolean
}

export interface ResearchSubscription {
  id: string
  projectId: string
  query: string
  lastCheckedAt: number
  seenIds: string[]
}

export interface ResearchSnapshot {
  id: string
  projectId: string
  label: string
  at: number
  file: string
  bytes: number
}

/** A seminar deck scaffold: real counts, script slots still marked `待补`. */
export interface ResearchDeck {
  id: string
  projectId: string
  title: string
  /** Absolute path of the generated .md, the agent edits it in place. */
  path: string
  at: number
  paperIds: string[]
  pages: number
}

export interface ResearchCollections {
  papers: ResearchPaper[]
  experiments: ResearchExperiment[]
  figures: ResearchFigure[]
  ideas: ResearchIdea[]
  servers: ResearchServer[]
  jobs: ResearchJob[]
  venues: ResearchVenue[]
  subscriptions: ResearchSubscription[]
  snapshots: ResearchSnapshot[]
  decks: ResearchDeck[]
}

export interface ResearchStore extends ResearchCollections {
  version: number
  projects: ResearchProject[]
  updatedAt: number
}

export interface ResearchChange {
  at: number
  revision: number
  reason: string
}

export interface ResearchStateResponse {
  store: ResearchStore
  changes: ResearchChange[]
  /** Absolute path of the research root on the server (`<root>/projects/<id>`). */
  root?: string
}

function profileParam(profile?: string | null): string | null {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || null
}

function qs(params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString()
  return search ? `?${search}` : ''
}

export async function fetchResearchState(profile?: string | null): Promise<ResearchStateResponse> {
  const value = profileParam(profile)
  return request<ResearchStateResponse>(`/api/studio/research/state${qs(value ? { profile: value } : {})}`)
}

/* ------------------------------------------------------------- decks */

/** One generated seminar deck as the panel lists it (name + on-disk size). */
export interface ResearchDeckListItem {
  id: string
  file: string
  sizeBytes: number
  at: number
}

export async function fetchResearchDecks(
  projectId: string,
  profile?: string | null,
): Promise<ResearchDeckListItem[]> {
  const value = profileParam(profile)
  const result = await request<{ decks: ResearchDeckListItem[] }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/decks${qs(value ? { profile: value } : {})}`,
  )
  return Array.isArray(result.decks) ? result.decks : []
}

export async function createResearchDeck(
  projectId: string,
  body: { title?: string; progress?: string; paperIds?: string[]; audience?: string },
  profile?: string | null,
): Promise<{ deck: ResearchDeck; path: string; markdown: string }> {
  return request<{ deck: ResearchDeck; path: string; markdown: string }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/decks`,
    { method: 'POST', body: JSON.stringify({ ...body, profile: profileParam(profile) || undefined }) },
  )
}

/** One `events.jsonl` change record, as the panel's ledger list consumes it. */
export interface ResearchChangeLogEntry {
  at: number
  revision: number
  reason: string
  /** The rest is the event the ledger view renders; older servers omit it. */
  id?: string
  ts?: string
  action?: string
  actor?: { kind: string; id: string }
  refs?: Record<string, string>
  payload?: Record<string, unknown>
  projectId?: string
}

export async function fetchResearchChangeLog(params: {
  since?: string | undefined
  until?: string | undefined
  limit?: number | undefined
  order?: string | undefined
  projectId?: string | undefined
  profile?: string | null
}): Promise<ResearchChangeLogEntry[]> {
  const query: Record<string, string> = {}
  if (params.since) query.since = params.since
  if (params.until) query.until = params.until
  if (params.limit) query.limit = String(params.limit)
  if (params.order) query.order = params.order
  if (params.projectId) query.projectId = params.projectId
  const value = profileParam(params.profile)
  if (value) query.profile = value
  const result = await request<{ events: ResearchChangeLogEntry[] }>(
    `/api/studio/research/ledger/events${qs(query)}`,
  )
  return Array.isArray(result.events) ? result.events : []
}

export async function createResearchProject(title: string, profile?: string | null): Promise<ResearchProject> {
  const result = await request<{ project: ResearchProject }>('/api/studio/research/projects', {
    method: 'POST',
    body: JSON.stringify({ title, profile: profileParam(profile) || undefined }),
  })
  return result.project
}

export async function renameResearchProject(id: string, title: string, profile?: string | null): Promise<ResearchProject> {
  const result = await request<{ project: ResearchProject }>(`/api/studio/research/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title, profile: profileParam(profile) || undefined }),
  })
  return result.project
}

export async function deleteResearchProject(id: string, profile?: string | null): Promise<{ cascaded: number }> {
  return request<{ cascaded: number }>(`/api/studio/research/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ profile: profileParam(profile) || undefined }),
  })
}

export async function createResearchItem<T extends { id: string }>(
  collection: ResearchCollection,
  item: Record<string, unknown>,
  profile?: string | null,
): Promise<T> {
  const result = await request<{ item: T }>(`/api/studio/research/items/${collection}`, {
    method: 'POST',
    body: JSON.stringify({ ...item, profile: profileParam(profile) || undefined }),
  })
  return result.item
}

export async function updateResearchItem<T extends { id: string }>(
  collection: ResearchCollection,
  id: string,
  patch: Record<string, unknown>,
  profile?: string | null,
): Promise<T> {
  const result = await request<{ item: T }>(
    `/api/studio/research/items/${collection}/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, profile: profileParam(profile) || undefined }),
    },
  )
  return result.item
}

export async function deleteResearchItem(
  collection: ResearchCollection,
  id: string,
  profile?: string | null,
): Promise<void> {
  await request<{ ok: boolean }>(`/api/studio/research/items/${collection}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ profile: profileParam(profile) || undefined }),
  })
}

/* ------------------------------------------------------------------ arxiv */

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

export async function searchArxivResearch(
  query: string,
  max = 10,
  profile?: string | null,
): Promise<ArxivSearchResult> {
  const value = profileParam(profile)
  return request<ArxivSearchResult>(
    `/api/studio/research/arxiv/search${qs({ query, max: String(max), ...(value ? { profile: value } : {}) })}`,
  )
}

export async function importArxivPaper(
  projectId: string,
  entry: ArxivEntry,
  profile?: string | null,
): Promise<{ item: ResearchPaper; duplicate: boolean }> {
  return request<{ item: ResearchPaper; duplicate: boolean }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/papers/import-arxiv`,
    {
      method: 'POST',
      body: JSON.stringify({ entry, profile: profileParam(profile) || undefined }),
    },
  )
}

export interface SubscriptionCheckResult extends ArxivSearchResult {
  added: Array<{ id: string; title: string; arxivId: string }>
  total: number
}

export async function checkResearchSubscription(
  id: string,
  profile?: string | null,
): Promise<SubscriptionCheckResult> {
  return request<SubscriptionCheckResult>(
    `/api/studio/research/items/subscriptions/${encodeURIComponent(id)}/check`,
    {
      method: 'POST',
      body: JSON.stringify({ profile: profileParam(profile) || undefined }),
    },
  )
}

/* ------------------------------------------------------------------- paper */

export interface OutlineNode {
  id: string
  level: number
  title: string
  label: string
  line: number
  children: OutlineNode[]
}

export interface PaperSource {
  projectId: string
  path: string
  source: string
  exists: boolean
  bytes: number
  updatedAt: number
  outline: OutlineNode[]
}

export async function fetchPaperSource(
  projectId: string,
  profile?: string | null,
): Promise<PaperSource> {
  const value = profileParam(profile)
  const result = await request<{ paper: PaperSource }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/paper${qs(value ? { profile: value } : {})}`,
  )
  return result.paper
}

export async function savePaperSource(
  projectId: string,
  source: string,
  profile?: string | null,
): Promise<PaperSource> {
  const result = await request<{ paper: PaperSource }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/paper`,
    {
      method: 'PUT',
      body: JSON.stringify({ source, profile: profileParam(profile) || undefined }),
    },
  )
  return result.paper
}

/** 一条 BibTeX 条目：引用键、小写类型、小写字段名 → 原始值。 */
export interface ResearchBibEntry {
  key: string
  type: string
  fields: Record<string, string>
}

export interface ResearchBibliography {
  projectId: string
  path: string
  entries: ResearchBibEntry[]
  /** 乐观并发的基准；文件不存在时为 null。 */
  mtimeMs: number | null
}

export async function fetchResearchBibliography(
  projectId: string,
  profile?: string | null,
): Promise<ResearchBibliography> {
  const value = profileParam(profile)
  const result = await request<{ bibliography: ResearchBibliography }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/bibliography${qs(value ? { profile: value } : {})}`,
  )
  return result.bibliography
}

export async function saveResearchBibliography(
  projectId: string,
  entries: ResearchBibEntry[],
  baseMtimeMs: number | null,
  profile?: string | null,
): Promise<{ mtimeMs: number }> {
  return request<{ mtimeMs: number }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/bibliography`,
    {
      method: 'PUT',
      body: JSON.stringify({ entries, baseMtimeMs, profile: profileParam(profile) || undefined }),
    },
  )
}

/** 把已收文献投影成 `@misc` 条目追加进 references.bib；返回写入与跳过的条数。 */
export async function importResearchPapersToBib(
  projectId: string,
  arxivIds: string[],
  profile?: string | null,
): Promise<{ added: number; skipped: number }> {
  return request<{ added: number; skipped: number }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/papers/import-bib`,
    {
      method: 'POST',
      body: JSON.stringify({ arxivIds, profile: profileParam(profile) || undefined }),
    },
  )
}

/** 论文快照列表项（与上游 `PaperSnapshotView` 同形）。 */
export interface ResearchSnapshotView {
  id: string
  createdAt: string
  files: { path: string; sizeBytes: number }[]
  sizeBytes: number
  /** ekko 侧记录的手写标签，面板可选用。 */
  label?: string
}

export interface ResearchSnapshotContent {
  id: string
  files: { path: string; content: string }[]
}

export async function fetchResearchSnapshots(
  projectId: string,
  profile?: string | null,
): Promise<ResearchSnapshotView[]> {
  const value = profileParam(profile)
  const result = await request<{ snapshots: ResearchSnapshotView[] }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/snapshots${qs(value ? { profile: value } : {})}`,
  )
  return result.snapshots
}

export async function fetchResearchSnapshotContent(
  projectId: string,
  snapshotId: string,
  profile?: string | null,
): Promise<ResearchSnapshotContent> {
  const value = profileParam(profile)
  return request<ResearchSnapshotContent>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}${qs(value ? { profile: value } : {})}`,
  )
}

/**
 * 回滚到某个快照。`baseMtimeMs` 是面板读到的 `main.tex` mtime，服务端据此做乐观并发：
 * 磁盘上的 mtime 已经变了就回 409 `conflict`，绝不覆盖用户没看到的编辑。
 */
export async function revertResearchPaperSnapshot(
  projectId: string,
  snapshotId: string,
  baseMtimeMs: number | null,
  profile?: string | null,
): Promise<{ mtimeMs: number }> {
  return request<{ mtimeMs: number }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({ baseMtimeMs, profile: profileParam(profile) || undefined }),
    },
  )
}

export async function createPaperSnapshot(
  projectId: string,
  label: string,
  profile?: string | null,
): Promise<ResearchSnapshot> {
  const result = await request<{ snapshot: ResearchSnapshot }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/snapshots`,
    {
      method: 'POST',
      body: JSON.stringify({ label, profile: profileParam(profile) || undefined }),
    },
  )
  return result.snapshot
}

export async function restorePaperSnapshot(
  projectId: string,
  snapshotId: string,
  profile?: string | null,
): Promise<PaperSource> {
  const result = await request<{ paper: PaperSource }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({ profile: profileParam(profile) || undefined }),
    },
  )
  return result.paper
}

/* ------------------------------------------------------------------- deck */

export interface DeckInput {
  title?: string
  progress?: string
  paperIds?: string[]
  audience?: string
}

/**
 * The host builds the skeleton from the project's records and returns the
 * markdown; the agent only fills the `待补` script slots afterwards.
 */
export async function buildResearchDeck(
  projectId: string,
  input: DeckInput = {},
  profile?: string | null,
): Promise<{ deck: ResearchDeck; path: string; markdown: string }> {
  return request<{ deck: ResearchDeck; path: string; markdown: string }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/decks`,
    {
      method: 'POST',
      body: JSON.stringify({ ...input, profile: profileParam(profile) || undefined }),
    },
  )
}

/** Read a generated deck back; `exists` is false when the .md is gone. */
/** The deck file's bytes (pptx) — the download anchor needs the real binary. */
export async function fetchResearchDeckFile(
  projectId: string,
  deckId: string,
  profile?: string | null,
): Promise<Blob> {
  const value = profileParam(profile)
  return requestBlob(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/decks/${encodeURIComponent(deckId)}/file`
    + qs(value ? { profile: value } : {}),
  )
}

export async function fetchResearchDeck(
  projectId: string,
  deckId: string,
  profile?: string | null,
): Promise<{ deck: ResearchDeck; markdown: string; exists: boolean }> {
  const value = profileParam(profile)
  return request<{ deck: ResearchDeck; markdown: string; exists: boolean }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/decks/${encodeURIComponent(deckId)}${qs(value ? { profile: value } : {})}`,
  )
}

/* --------------------------------------------------- deck preview (slides) */

/**
 * One text run of a slide. Sizes and spacings are percentages of the slide
 * width (the server already did the pt → % conversion), so the renderer can
 * use them as `cqw` values directly.
 */
export interface ResearchDeckPreviewRun {
  t: string
  sz: number
  b: boolean
  c: string
}

export interface ResearchDeckPreviewPara {
  runs: ResearchDeckPreviewRun[]
  bullet: boolean
  indent: number
  lineHeight: number
  spaceAfter: number
  align: 'l' | 'ctr' | 'r'
}

export interface ResearchDeckPreviewShape {
  kind: 'text' | 'rect'
  x: number
  y: number
  w: number
  h: number
  anchor: 't' | 'ctr' | 'b'
  fill?: string
  paras?: ResearchDeckPreviewPara[]
}

export interface ResearchDeckPreview {
  file: string
  kind: 'pptx' | 'markdown'
  aspect: number
  pages: Array<{ shapes: ResearchDeckPreviewShape[] }>
}

/** The deck flattened into pages of positioned shapes, for the in-panel preview. */
export async function fetchResearchDeckPreview(
  projectId: string,
  deckId: string,
  profile?: string | null,
): Promise<ResearchDeckPreview> {
  const value = profileParam(profile)
  return request<ResearchDeckPreview>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/decks/${encodeURIComponent(deckId)}/preview`
    + qs(value ? { profile: value } : {}),
  )
}

/** Pin (or decline, with `pinned: false`) one change-log moment. */
export async function pinResearchMoment(
  targetEventId: string,
  options: { note?: string; pinned?: boolean } = {},
  profile?: string | null,
): Promise<{ mark: unknown }> {
  return request<{ mark: unknown }>('/api/studio/research/moments/pin', {
    method: 'POST',
    body: JSON.stringify({
      targetEventId,
      note: options.note ?? '',
      pinned: options.pinned !== false,
      profile: profileParam(profile) || undefined,
    }),
  })
}

/** Declare one eureka (顿悟) against an idea line or a project. */
export async function declareResearchEureka(
  input: { ideaId?: string; projectId?: string; title: string },
  profile?: string | null,
): Promise<{ eureka: unknown }> {
  return request<{ eureka: unknown }>('/api/studio/research/eureka', {
    method: 'POST',
    body: JSON.stringify({ ...input, profile: profileParam(profile) || undefined }),
  })
}

export async function fetchResearchEureka(
  profile?: string | null,
): Promise<{ declarations: Array<{ id: string; title: string; lineId: string | null; ideaId: string | null; projectId: string | null; at: string }> }> {
  const value = profileParam(profile)
  return request<{ derivedAt: string; declarations: Array<{ id: string; title: string; lineId: string | null; ideaId: string | null; projectId: string | null; at: string }> }>(
    `/api/studio/research/eureka${qs(value ? { profile: value } : {})}`,
  )
}

/** One built-in venue template as the paper header's picker shows it. */
export interface ResearchVenueTemplate {
  id: string
  name: string
  series: string
  url: string
}

export async function fetchVenueTemplates(profile?: string | null): Promise<ResearchVenueTemplate[]> {
  const value = profileParam(profile)
  const result = await request<{ templates: ResearchVenueTemplate[] }>(
    `/api/studio/research/venue-templates${qs(value ? { profile: value } : {})}`,
  )
  return Array.isArray(result.templates) ? result.templates : []
}

export async function applyResearchVenue(
  projectId: string,
  options: { templateId?: string; customName?: string },
  profile?: string | null,
): Promise<{ venue: { id: string; name: string; series: string; url: string }; warnings: string[] }> {
  return request<{ venue: { id: string; name: string; series: string; url: string }; warnings: string[] }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/venue-template`,
    { method: 'POST', body: JSON.stringify({ ...options, profile: profileParam(profile) || undefined }) },
  )
}

export async function clearResearchVenue(projectId: string, profile?: string | null): Promise<void> {
  const value = profileParam(profile)
  await request(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/venue-template${qs(value ? { profile: value } : {})}`,
    { method: 'DELETE' },
  )
}

/** Import one mimir-wiki snapshot; `merge` skips existing ids, `replace` wipes first. */
export async function importResearchWiki(
  snapshot: unknown,
  mode: 'merge' | 'replace',
  confirmReplace: boolean,
  profile?: string | null,
): Promise<{ imported: Record<string, number>; skipped: Record<string, number> }> {
  return request<{ imported: Record<string, number>; skipped: Record<string, number> }>(
    '/api/studio/research/wiki/import',
    {
      method: 'POST',
      body: JSON.stringify({
        snapshot,
        mode,
        confirmReplace,
        profile: profileParam(profile) || undefined,
      }),
    },
  )
}

/* ------------------------------------------------------ 工作树（成长记录） */

/** Declare the mainline ref: one project lane or one idea lane. */
export async function setResearchMainline(
  target: { projectId?: string; ideaId?: string },
  profile?: string | null,
): Promise<{ mainline: { lineId: string; declaredAt: number } }> {
  return request<{ mainline: { lineId: string; declaredAt: number } }>(
    '/api/studio/research/worktree/mainline',
    { method: 'POST', body: JSON.stringify({ ...target, profile: profileParam(profile) || undefined }) },
  )
}

/** Declare (or clear, with an empty string) one derivation edge between lanes. */
export async function setResearchIdeaParent(
  ideaId: string,
  parentIdeaId: string | null,
  profile?: string | null,
): Promise<{ idea: ResearchIdea }> {
  return request<{ idea: ResearchIdea }>('/api/studio/research/worktree/idea-parent', {
    method: 'POST',
    body: JSON.stringify({
      ideaId,
      parentIdeaId: parentIdeaId ?? '',
      profile: profileParam(profile) || undefined,
    }),
  })
}

/** Adopt one idea lane (the kind flips from idea to decision). */
export async function adoptResearchIdea(
  ideaId: string,
  profile?: string | null,
): Promise<{ idea: ResearchIdea }> {
  return request<{ idea: ResearchIdea }>('/api/studio/research/worktree/adopt', {
    method: 'POST',
    body: JSON.stringify({ ideaId, profile: profileParam(profile) || undefined }),
  })
}

/** Close one idea lane with a reason (a documented No). */
export async function closeResearchIdea(
  ideaId: string,
  reason: string,
  profile?: string | null,
): Promise<{ idea: ResearchIdea }> {
  return request<{ idea: ResearchIdea }>('/api/studio/research/worktree/close', {
    method: 'POST',
    body: JSON.stringify({ ideaId, reason, profile: profileParam(profile) || undefined }),
  })
}

/** Upload one image file into the project's paper directory (`figures/` by default). */
export async function uploadResearchFigure(
  projectId: string,
  file: File,
  dir?: string,
  profile?: string | null,
): Promise<{ figure: ResearchFigure; relPath: string }> {
  const value = profileParam(profile)
  const query: Record<string, string> = { name: file.name }
  if (dir !== undefined && dir !== '') query.dir = dir
  if (value) query.profile = value
  return request<{ figure: ResearchFigure; relPath: string }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/figures/upload${qs(query)}`,
    {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    },
  )
}

/** Rename one figure file inside the project's paper directory. */
export async function renameResearchFigure(
  projectId: string,
  relPath: string,
  newName: string,
  profile?: string | null,
): Promise<{ path: string; name: string; id: string | null }> {
  return request<{ path: string; name: string; id: string | null }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/figures/rename`,
    {
      method: 'POST',
      body: JSON.stringify({ path: relPath, name: newName, profile: profileParam(profile) || undefined }),
    },
  )
}

/** Delete one figure (file + store record) of the project's paper directory. */
export async function deleteResearchFigure(
  projectId: string,
  relPath: string,
  profile?: string | null,
): Promise<void> {
  const value = profileParam(profile)
  await request<{ ok: boolean }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/figure${qs({ path: relPath, ...(value ? { profile: value } : {}) })}`,
    { method: 'DELETE' },
  )
}

/**
 * Produce the LaTeX-embeddable sibling of one figure (`figures/foo.svg` →
 * `figures/foo.pdf`). `converter` is `cached` when a fresh product already
 * existed, else the converter that produced it.
 */
export async function convertResearchFigure(
  projectId: string,
  relPath: string,
  profile?: string | null,
): Promise<{ relPath: string; converter: string }> {
  return request<{ relPath: string; converter: string }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/figures/convert`,
    {
      method: 'POST',
      body: JSON.stringify({ path: relPath, profile: profileParam(profile) || undefined }),
    },
  )
}

/**
 * The compiled `main.pdf` as a blob. An iframe cannot carry the Bearer header,
 * so the panel turns this into an object URL for the preview pane.
 */
/** One figure file of a project, as bytes (the panel turns it into an object URL). */
export async function fetchResearchFigure(
  projectId: string,
  relPath: string,
  profile?: string | null,
): Promise<Blob> {
  const value = profileParam(profile)
  return requestBlob(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/figure${qs({ path: relPath, ...(value ? { profile: value } : {}) })}`,
  )
}

export async function fetchResearchPdf(projectId: string, profile?: string | null): Promise<Blob> {
  const value = profileParam(profile)
  const query = value ? `?profile=${encodeURIComponent(value)}` : ''
  return requestBlob(`/api/studio/research/projects/${encodeURIComponent(projectId)}/pdf${query}`)
}

export interface CompileStatus {
  projectId: string
  environment: { engine: 'latexmk' | 'tectonic' | 'xelatex' | ''; available: boolean; detail: string }
  sourcePath: string
  sourceExists: boolean
  sourceUpdatedAt: number
  pdfPath: string
  hasPdf: boolean
  pdfUpdatedAt: number
  pdfBytes: number
  upToDate: boolean
}

export async function fetchCompileStatus(
  projectId: string,
  profile?: string | null,
): Promise<CompileStatus> {
  const value = profileParam(profile)
  const result = await request<{ status: CompileStatus }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/compile/status${qs(value ? { profile: value } : {})}`,
  )
  return result.status
}

/** Status plus the last recorded run (survives a host restart). */
export async function fetchCompileSummary(
  projectId: string,
  profile?: string | null,
): Promise<{ status: CompileStatus; last: CompileResult | null }> {
  const value = profileParam(profile)
  return request<{ status: CompileStatus; last: CompileResult | null }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/compile/status${qs(value ? { profile: value } : {})}`,
  )
}

/* ----------------------------------------------------------------- compile */

export interface CompileResult {
  projectId: string
  ok: boolean
  engine: string
  exitCode: number
  durationMs: number
  at: number
  logTail: string
  logPath: string
  pdfPath: string
  pdfBytes: number
  timedOut: boolean
}

export async function compileResearchProject(
  projectId: string,
  profile?: string | null,
): Promise<{ result: CompileResult; status: CompileStatus }> {
  return request<{ result: CompileResult; status: CompileStatus }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/compile`,
    { method: 'POST', body: JSON.stringify({ profile: profileParam(profile) || undefined }) },
  )
}

export interface ResearchArtifactPayload {
  name: string
  content: string
  mtimeMs: number
}

export async function fetchResearchArtifact(
  projectId: string,
  name: string,
  profile?: string | null,
): Promise<ResearchArtifactPayload> {
  const value = profileParam(profile)
  return request<ResearchArtifactPayload>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/artifact${qs({ name, ...(value ? { profile: value } : {}) })}`,
  )
}

/* ------------------------------------------------------------------ ledger */

export async function fetchLedgerWorktree(profile?: string | null): Promise<unknown> {
  const value = profileParam(profile)
  return request<unknown>(`/api/studio/research/ledger/worktree${qs(value ? { profile: value } : {})}`)
}

export async function fetchLedgerForaging(profile?: string | null): Promise<unknown> {
  const value = profileParam(profile)
  return request<unknown>(`/api/studio/research/ledger/foraging${qs(value ? { profile: value } : {})}`)
}

export async function fetchLedgerMoments(profile?: string | null): Promise<unknown> {
  const value = profileParam(profile)
  return request<unknown>(`/api/studio/research/ledger/moments${qs(value ? { profile: value } : {})}`)
}

export async function fetchLedgerEvidence(profile?: string | null): Promise<unknown> {
  const value = profileParam(profile)
  return request<unknown>(`/api/studio/research/ledger/evidence${qs(value ? { profile: value } : {})}`)
}

export async function fetchLedgerDigest(
  options: { tier?: string; since?: string; until?: string; lang?: string } = {},
  profile?: string | null,
): Promise<unknown> {
  const value = profileParam(profile)
  const params: Record<string, string> = {}
  if (options.tier !== undefined) params.tier = options.tier
  if (options.since !== undefined) params.since = options.since
  if (options.until !== undefined) params.until = options.until
  if (options.lang !== undefined) params.lang = options.lang
  if (value !== null) params.profile = value
  return request<unknown>(`/api/studio/research/ledger/digest${qs(params)}`)
}

/* ------------------------------------------------------------------ zotero */

/** The probe's settled state; the message is only present when `failed`. */
export interface ZoteroStatus {
  state: 'unconfigured' | 'ok' | 'failed'
  message?: string
}

export async function fetchZoteroStatus(profile?: string | null): Promise<ZoteroStatus> {
  const value = profileParam(profile)
  return request<ZoteroStatus>(`/api/studio/research/zotero/status${qs(value ? { profile: value } : {})}`)
}

/** One Zotero collection as the export picker lists it. */
export interface ZoteroCollectionView {
  key: string
  name: string
  itemCount: number
}

/** One Zotero reference item reduced to the fields the workbench shows. */
export interface ZoteroItemView {
  key: string
  title: string
  authors: string[]
  year: string
  doi: string
  arxivId: string | null
  publicationTitle: string
  url: string
}

export async function fetchZoteroCollections(
  profile?: string | null,
): Promise<ZoteroCollectionView[]> {
  const value = profileParam(profile)
  const result = await request<{ collections: ZoteroCollectionView[] }>(
    `/api/studio/research/zotero/collections${qs(value ? { profile: value } : {})}`,
  )
  return Array.isArray(result.collections) ? result.collections : []
}

export async function searchZoteroItems(
  query: string,
  maxResults?: number,
  profile?: string | null,
): Promise<ZoteroItemView[]> {
  const value = profileParam(profile)
  const params: Record<string, string> = { query }
  if (typeof maxResults === 'number') params.max = String(maxResults)
  if (value) params.profile = value
  const result = await request<{ results: ZoteroItemView[] }>(
    `/api/studio/research/zotero/items${qs(params)}`,
  )
  return Array.isArray(result.results) ? result.results : []
}

/** Import one Zotero item into the project's papers table. */
export async function importZoteroPaper(
  projectId: string,
  key: string,
  profile?: string | null,
): Promise<{ imported: boolean; paperId: string }> {
  return request<{ imported: boolean; paperId: string }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/papers/import-zotero`,
    { method: 'POST', body: JSON.stringify({ key, profile: profileParam(profile) || undefined }) },
  )
}

/** Merge one Zotero collection's BibTeX into the project's `references.bib`. */
export async function importZoteroCollectionBib(
  projectId: string,
  collectionKey: string,
  profile?: string | null,
): Promise<{ added: string[]; skipped: string[] }> {
  return request<{ added: string[]; skipped: string[] }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/bibliography/import-zotero`,
    {
      method: 'POST',
      body: JSON.stringify({ collectionKey, profile: profileParam(profile) || undefined }),
    },
  )
}

/* ------------------------------------------------ 期刊条目 / 证据边 */

/** 一条手写记录（L2 日志行）的写入结果。 */
export interface JournalEntryEvent {
  id: string
  ts: string
  actor: { kind: string; id: string }
  action: string
  refs: Record<string, string>
  payload: Record<string, unknown>
}

export async function writeJournalEntry(
  input: {
    text: string
    projectId?: string
    ideaId?: string
    valence?: number
    arousal?: number
    question?: { kind: string; lineId: string }
  },
  profile?: string | null,
): Promise<{ event: JournalEntryEvent }> {
  return request<{ event: JournalEntryEvent }>('/api/studio/research/journal', {
    method: 'POST',
    body: JSON.stringify({ ...input, profile: profileParam(profile) || undefined }),
  })
}

/** 断言一条证据边（幂等：同样的 rel/src/dst 只会落一行）。 */
export interface EvidenceEdgeRequest {
  rel: string
  src: string
  dst: string
  srcLabel?: string
  dstLabel?: string
  note?: string
  projectId?: string
  ideaId?: string
  claimId?: string
}

export async function declareEvidenceEdge(
  input: EvidenceEdgeRequest,
  profile?: string | null,
): Promise<{ dedupKey: string; rel: string; src: string; dst: string }> {
  return request<{ dedupKey: string; rel: string; src: string; dst: string }>(
    '/api/studio/research/evidence/edges',
    { method: 'POST', body: JSON.stringify({ ...input, profile: profileParam(profile) || undefined }) },
  )
}

export async function retractEvidenceEdge(
  input: { dedupKey: string; reason?: string; projectId?: string; ideaId?: string; claimId?: string },
  profile?: string | null,
): Promise<{ dedupKey: string }> {
  return request<{ dedupKey: string }>('/api/studio/research/evidence/edges/retract', {
    method: 'POST',
    body: JSON.stringify({ ...input, profile: profileParam(profile) || undefined }),
  })
}

/* -------------------------------------------------- 文献 PDF / 项目导入 */

/** 下载一篇论文的 PDF 到项目目录，返回带上 `pdfPath` 的记录。 */
export async function fetchResearchPaperPdf(
  projectId: string,
  arxivId: string,
  profile?: string | null,
): Promise<{ paper: ResearchPaper }> {
  return request<{ paper: ResearchPaper }>(
    `/api/studio/research/projects/${encodeURIComponent(projectId)}/papers/fetch-pdf`,
    { method: 'POST', body: JSON.stringify({ arxivId, profile: profileParam(profile) || undefined }) },
  )
}

/** 把一个已有的 LaTeX 目录复制进来、注册成新项目。 */
export interface ResearchImportedProjectView {
  projectId: string
  title: string
  paperDir: string
  entryTex: string
  figureCount: number
  warnings: string[]
}

export async function importResearchProject(
  path: string,
  title?: string,
  profile?: string | null,
): Promise<ResearchImportedProjectView> {
  return request<ResearchImportedProjectView>('/api/studio/research/projects/import', {
    method: 'POST',
    body: JSON.stringify({
      path,
      ...(title === undefined ? {} : { title }),
      profile: profileParam(profile) || undefined,
    }),
  })
}

/* ---------------------------------------------------------------- 设置 */

/** 图片生成配置的对外视图（key 只给掩码后的预览）。 */
export interface ImageGenConfigView {
  configured: boolean
  baseUrl: string
  model: string
  size: string
  apiKeyPreview: string
}

export async function fetchImageGenConfig(
  profile?: string | null,
): Promise<ImageGenConfigView> {
  const value = profileParam(profile)
  return request<ImageGenConfigView>(`/api/studio/research/settings/image-gen${qs(value ? { profile: value } : {})}`)
}

/** 只传要改的字段；`apiKey` 缺省表示保留已存的 key。 */
export async function saveImageGenConfig(
  patch: { baseUrl?: string; apiKey?: string; model?: string; size?: string },
  profile?: string | null,
): Promise<ImageGenConfigView> {
  return request<ImageGenConfigView>('/api/studio/research/settings/image-gen', {
    method: 'POST',
    body: JSON.stringify({ ...patch, profile: profileParam(profile) || undefined }),
  })
}

/** SearXNG 配置的对外视图（Ollama key 只给掩码）。 */
export interface SxngConfigView {
  configured: boolean
  baseUrl: string
  defaultEngine: string
  allowedEngines: string[]
  defaultLimit: number
  defaultFormat: 'md' | 'json'
  useProxy: boolean
  proxyUrl: string
  timeout: number
  ollamaApiKeyPreview: string
  redundancyThreshold: number
  redundancyBigramThreshold: number
}

export async function fetchSxngConfig(profile?: string | null): Promise<SxngConfigView> {
  const value = profileParam(profile)
  return request<SxngConfigView>(`/api/studio/research/settings/sxng${qs(value ? { profile: value } : {})}`)
}

export async function saveSxngConfig(
  patch: {
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
  profile?: string | null,
): Promise<SxngConfigView> {
  return request<SxngConfigView>('/api/studio/research/settings/sxng', {
    method: 'POST',
    body: JSON.stringify({ ...patch, profile: profileParam(profile) || undefined }),
  })
}

/** 一条网页检索结果（SearXNG 的 `results[]` 行）。 */
export interface WebSearchResult {
  title: string
  url: string
  content: string
  engine: string
  category: string
  publishedDate: string
}

export async function searchWebResearch(
  query: string,
  options: { maxResults?: number; categories?: string; lang?: string } = {},
  profile?: string | null,
): Promise<WebSearchResult[]> {
  const value = profileParam(profile)
  const params: Record<string, string> = { query }
  if (typeof options.maxResults === 'number') params.max = String(options.maxResults)
  if (options.categories !== undefined && options.categories !== '') params.categories = options.categories
  if (options.lang !== undefined && options.lang !== '') params.lang = options.lang
  if (value) params.profile = value
  const result = await request<{ results: WebSearchResult[] }>(
    `/api/studio/research/web/search${qs(params)}`,
  )
  return Array.isArray(result.results) ? result.results : []
}

/* --------------------------------------------------------------------- ssh */

export interface SshProbeResult {
  ok: boolean
  status: 'online' | 'offline'
  detail: string
  raw: string
  at: number
}

export async function checkResearchServer(
  id: string,
  profile?: string | null,
): Promise<{ probe: SshProbeResult; server: ResearchServer }> {
  return request<{ probe: SshProbeResult; server: ResearchServer }>(
    `/api/studio/research/items/servers/${encodeURIComponent(id)}/check`,
    { method: 'POST', body: JSON.stringify({ profile: profileParam(profile) || undefined }) },
  )
}

export interface SubmittedJob {
  ok: boolean
  pid: string
  detail: string
  logPath: string
}

export async function submitResearchJob(
  serverId: string,
  payload: { name: string; command: string },
  profile?: string | null,
): Promise<{ job: ResearchJob; submitted: SubmittedJob }> {
  return request<{ job: ResearchJob; submitted: SubmittedJob }>(
    `/api/studio/research/items/servers/${encodeURIComponent(serverId)}/jobs`,
    {
      method: 'POST',
      body: JSON.stringify({ ...payload, profile: profileParam(profile) || undefined }),
    },
  )
}

export interface JobObservation {
  state: string
  detail: string
  logTail: string
  exitCode: number | null
}

export async function refreshResearchJob(
  id: string,
  profile?: string | null,
): Promise<{ job: ResearchJob; state: JobObservation }> {
  return request<{ job: ResearchJob; state: JobObservation }>(
    `/api/studio/research/items/jobs/${encodeURIComponent(id)}/refresh`,
    { method: 'POST', body: JSON.stringify({ profile: profileParam(profile) || undefined }) },
  )
}

/* ------------------------------------------------------------------ venues */

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

export interface VenueCatalogResponse {
  items: VenueDeadline[]
  total: number
  fetchedAt: number
  stale: boolean
  error: string
}

export async function fetchVenueCatalog(
  params: { q?: string; ccf?: string; limit?: number; force?: boolean } = {},
  profile?: string | null,
): Promise<VenueCatalogResponse> {
  const value = profileParam(profile)
  const query: Record<string, string> = {}
  if (params.q) query.q = params.q
  if (params.ccf) query.ccf = params.ccf
  if (params.limit) query.limit = String(params.limit)
  if (params.force) query.force = '1'
  if (value) query.profile = value
  return request<VenueCatalogResponse>(`/api/studio/research/venues/catalog${qs(query)}`)
}

/**
 * Subscribe to host-side writes (agent, another window). Returns an unsubscribe
 * function; the caller decides how to debounce a refresh.
 */
export function subscribeResearchEvents(
  handler: (change: ResearchChange) => void,
  profile?: string | null,
): () => void {
  const base = getBaseUrlValue()
  const token = getApiKey()
  if (!token) return () => {}
  const activeProfile = profileParam(profile) || getActiveProfileName()
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (activeProfile) params.set('profile', activeProfile)
  const url = `${base}/api/studio/research/events${params.toString() ? `?${params.toString()}` : ''}`

  const source = new EventSource(url)
  const onChange = (event: MessageEvent<string>) => {
    try {
      handler(JSON.parse(event.data) as ResearchChange)
    } catch {
      handler({ at: Date.now(), revision: 0, reason: 'unknown' })
    }
  }
  source.addEventListener('change', onChange as EventListener)
  return () => {
    source.removeEventListener('change', onChange as EventListener)
    source.close()
  }
}
