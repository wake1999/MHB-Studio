/**
 * 上游面板的 `research` Remote → ekko 现有的 `/api/studio/research/*` 适配层。
 *
 * 上游每个方法都返回两层结果：外层 `RemoteResult` 是传输层（`ok:false` 表示
 * 载体失败），内层 `ResearchResult` 是业务层（`ok:false` 带 `ResearchFailure`）。
 * 这里把 ekko 的 REST 调用包成同样的两层结构；还没接上的方法统一回传输层失败，
 * 面板会落到它自己的错误/空态上，不会崩。
 *
 * 迁移进度：项目列表、论文源码/大纲/编译、项目增删改已接；其余方法逐步补。
 */

import {
  checkResearchServer,
  checkResearchSubscription,
  compileResearchProject,
  adoptResearchIdea,
  applyResearchVenue,
  clearResearchVenue,
  closeResearchIdea,
  convertResearchFigure,
  createResearchDeck,
  createResearchItem,
  createResearchProject,
  declareResearchEureka,
  deleteResearchFigure,
  deleteResearchItem,
  deleteResearchProject,
  fetchCompileSummary,
  fetchPaperSource,
  fetchResearchBibliography,
  fetchResearchSnapshotContent,
  fetchResearchSnapshots,
  fetchResearchChangeLog,
  fetchResearchDeckFile,
  fetchResearchDecks,
  fetchResearchFigure,
  fetchResearchEureka,
  fetchResearchState as fetchResearchStateRaw,
  fetchVenueCatalog,
  fetchVenueTemplates,
  fetchZoteroStatus,
  fetchZoteroCollections,
  fetchImageGenConfig,
  fetchResearchPaperPdf,
  fetchSxngConfig,
  declareEvidenceEdge,
  importResearchProject,
  retractEvidenceEdge as retractEvidenceEdgeApi,
  saveImageGenConfig,
  saveSxngConfig,
  searchWebResearch,
  writeJournalEntry,
  importZoteroCollectionBib,
  importZoteroPaper,
  searchZoteroItems,
  fetchResearchArtifact,
  updateResearchItem,
  fetchLedgerDigest,
  fetchLedgerEvidence,
  fetchLedgerForaging,
  fetchLedgerMoments,
  fetchLedgerWorktree,
  pinResearchMoment,
  importArxivPaper,
  importResearchPapersToBib,
  importResearchWiki,
  renameResearchFigure,
  renameResearchProject,
  setResearchIdeaParent,
  setResearchMainline,
  revertResearchPaperSnapshot,
  savePaperSource,
  saveResearchBibliography,
  searchArxivResearch,
  submitResearchJob,
  uploadResearchFigure,
  type ArxivEntry as EkkoArxivEntry,
  type CompileResult,
  type CompileStatus,
  type ResearchExperiment,
  type ResearchFigure,
  type ResearchJob,
  type ResearchPaper,
  type ResearchServer,
  type ResearchStore,
  type ResearchSubscription,
  type ResearchVenue,
  type VenueDeadline,
} from '@/api/studio/research'
import { registerDeckBlob } from './deck-blobs'
import {
  reorderSections,
  reorderSubsections,
  sectionTitles,
  sectionTreeTitles,
  type TexSectionMove,
  type TexSubsectionMove,
} from './tex-reorder'
import { figureBlobEntry, registerFigureBlob } from './figure-blobs'
import { CCF_A_JOURNALS } from './venue-journals'

/** 外层传输结果：`ok:true` 带业务结果，`ok:false` 带载体失败。 */
type Carried<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 内层业务结果。 */
type Business<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function carried<T>(value: Business<T>): Carried<Business<T>> {
  return { ok: true, value }
}

function ok<T>(value: T): Business<T> {
  return { ok: true, value }
}

function failed<T>(code: string, message: string): Carried<Business<T>> {
  return { ok: false, error: { code, message } }
}

function businessFailed<T>(code: string, message: string): Carried<Business<T>> {
  return { ok: true, value: { ok: false, error: { code, message } } }
}

/** 把一次 ajax 失败翻译成传输层失败，避免整个控制器抛异常。 */
async function guard<T>(run: () => Promise<Carried<Business<T>>>): Promise<Carried<Business<T>>> {
  try {
    return await run()
  } catch (error) {
    return failed('transport', error instanceof Error ? error.message : String(error))
  }
}

/* --------------------------------------------------------------- mapping */

const STAGES = ['idea', 'plan', 'experiment', 'writing', 'done'] as const

function stageOf(store: ResearchStore, projectId: string): typeof STAGES[number] {
  const has = <T extends { projectId: string }>(list: readonly T[]): boolean =>
    list.some(item => item.projectId === projectId)
  if (has(store.decks)) return 'writing'
  if (has(store.experiments)) return 'experiment'
  if (has(store.papers)) return 'plan'
  return 'idea'
}

function artifactsOf(store: ResearchStore, projectId: string): string[] {
  const rows: Array<{ path: string; at: number }> = []
  for (const deck of store.decks) {
    if (deck.projectId === projectId && deck.path) rows.push({ path: deck.path, at: deck.at })
  }
  for (const figure of store.figures) {
    if (figure.projectId === projectId && figure.path) rows.push({ path: figure.path, at: figure.at })
  }
  for (const snapshot of store.snapshots) {
    if (snapshot.projectId === projectId) rows.push({ path: `snapshots/${snapshot.label}`, at: snapshot.at })
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, 8).map(row => row.path)
}

/**
 * 服务端 research 根目录的绝对路径，随 `/state` 一起下发。
 * prompt 里的工程目录必须给绝对值：dsh 的会话工作区就是 research 根，而 ekko 的
 * 会话 cwd 不是，`projects/<id>` 这种相对路径交到 agent 手里会指空。
 */
let researchRoot = ''

async function fetchResearchState(
  profile?: string | null,
): Promise<Awaited<ReturnType<typeof fetchResearchStateRaw>>> {
  const state = await fetchResearchStateRaw(profile)
  if (typeof state.root === 'string' && state.root !== '') researchRoot = state.root
  return state
}

function projectView(store: ResearchStore, project: ResearchStore['projects'][number]) {
  const rounds = store.ideas.filter(item => item.projectId === project.id && item.kind === 'decision').length
  return {
    id: project.id,
    title: project.title,
    stage: stageOf(store, project.id),
    paperDir: `projects/${project.id}`,
    // 只给 prompt builder 用（UI 传绝对目录），API 调用仍走上面的相对 paperDir。
    ...(researchRoot === '' ? {} : { absDir: `${researchRoot}/projects/${project.id}` }),
    reviewRounds: rounds,
    artifacts: artifactsOf(store, project.id),
    // 上游用 `venue === undefined` 区分「未选」；给 null 会让它去读 venue.name。
    venue: project.venue ?? undefined,
    updatedAt: new Date(project.updatedAt || Date.now()).toISOString(),
  }
}

/**
 * Turn a failed run's log into issue rows the panel can show and hand to the AI
 * fixer. Without this the panel only ever saw the status object (which carries
 * no failure), so a failed compile looked like "nothing happened".
 */
function compileIssues(last: CompileResult | null | undefined) {
  if (last === null || last === undefined || last.ok) return []
  const lines = String(last.logTail || '').split('\n').map(line => line.trim()).filter(Boolean)
  const errors = lines.filter(line => line.startsWith('!') || /:\d+:/.test(line)).slice(0, 3)
  const picked = errors.length > 0 ? errors : lines.slice(0, 1)
  const message = (picked.join(' ').trim() || 'compile failed').slice(0, 400)
  const at = /:(\d+):/.exec(picked[0] || '')
  return [{
    severity: 'error' as const,
    message,
    ...(at === null ? {} : { line: Number(at[1]) }),
  }]
}

function compileView(status: CompileStatus, last?: CompileResult | null) {
  const failed = last !== null && last !== undefined && !last.ok
  const state = failed ? 'error' : status.hasPdf ? 'ok' : 'idle'
  return {
    state,
    issues: compileIssues(last),
    engine: (status.environment?.engine || null) as string | null,
    pdfUpdatedAt: status.hasPdf ? status.pdfUpdatedAt : null,
    observed: true,
  }
}

/* ------------------------------------------------ 当前项目（上游是工作区级，
 * 而 ekko 的订阅/服务器/文献导入都挂在项目下）。bridge 每次收到新快照就同步一次。 */

let currentProjectId: string | null = null

export function setCurrentProjectId(projectId: string | null): void {
  currentProjectId = projectId
}

function projectOf(store: ResearchStore, explicit?: string | null): string {
  return explicit || currentProjectId || store.projects[0]?.id || ''
}

/* ------------------------------------------------- 记录映射（ekko → 上游）

 * 上游视图直接吃 wiki 记录（PaperRecord / ExperimentRecord / FigureEntry /
 * ServerRecord / VenueDeadlineView / JobRecord），字段比 ekko 的 store 富一些；
 * 这里按视图真正读到的字段补齐，缺的给空值而不是编造内容。 */

function isoOf(ms: number): string {
  return new Date(ms || Date.now()).toISOString()
}

function splitAuthors(raw: string): string[] {
  return raw
    .split(/[,，;；]|\band\b|\u3001/)
    .map(part => part.trim())
    .filter(Boolean)
}

/** ekko 的指标值是字符串，上游要 `number | string`：能转数字就转。 */
function metricValue(raw: string): number | string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : trimmed
}

function paperRecord(paper: ResearchPaper) {
  return {
    arxivId: paper.arxivId || paper.id,
    title: paper.title,
    authors: splitAuthors(paper.authors),
    summary: '',
    url: paper.url,
    notes: paper.notes,
    /* undefined = 从没编辑过标签，回退到 venue/year/status 派生；空数组 = 用户删光了，
       保持空 —— 否则删完标签一保存，卡片上又冒出 arXiv/2017/new。 */
    tags: paper.tags === undefined
      ? ([paper.venue, paper.year, paper.status].filter(Boolean) as string[])
      : paper.tags,
    /* 卡片上的相关度徽章读这个；0 表示还没打分，徽章不渲染。 */
    score: paper.score ?? 0,
    projectIds: paper.projectId ? [paper.projectId] : ([] as string[]),
    addedAt: isoOf(paper.addedAt),
    ...(paper.doi ? { doi: paper.doi } : {}),
    // 上游用 `pdfPath` 判断"这篇的 PDF 已经在本地"，没抓过就别给 null。
    ...(paper.pdfPath ? { pdfPath: paper.pdfPath } : {}),
  }
}

/** ekko 的 'planned' 在上游没有对应值，按「还没结束」落到 running。 */
function experimentStatus(status: string): 'running' | 'success' | 'failed' {
  // ekko stores the form's 成功/失败 as `success`/`failed`; upstream also uses
  // `done` for a finished run. Anything else is still in flight.
  if (status === 'done' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'failed'
  return 'running'
}

/** Stored experiments may omit blank optional fields; give the mapper its full shape. */
function fillExperiment(item: Record<string, unknown>): ResearchExperiment {
  return {
    id: typeof item.id === 'string' ? item.id : '',
    projectId: typeof item.projectId === 'string' ? item.projectId : '',
    name: typeof item.name === 'string' ? item.name : '',
    status: typeof item.status === 'string' ? item.status : 'running',
    config: typeof item.config === 'string' ? item.config : '',
    conclusion: typeof item.conclusion === 'string' ? item.conclusion : '',
    at: typeof item.at === 'number' ? item.at : Date.now(),
    metrics: Array.isArray(item.metrics) ? item.metrics as ResearchExperiment['metrics'] : [],
  } as ResearchExperiment
}

function experimentRecord(item: ResearchExperiment) {
  const metrics: Record<string, number | string> = {}
  const directions: Record<string, 'min' | 'max'> = {}
  for (const metric of item.metrics) {
    if (!metric.name) continue
    metrics[metric.name] = metricValue(metric.value)
    if (metric.better === 'max' || metric.better === 'min') directions[metric.name] = metric.better
  }
  return {
    id: item.id,
    projectId: item.projectId,
    name: item.name,
    status: experimentStatus(item.status),
    metrics,
    metricDirections: directions,
    updatedAt: isoOf(item.at),
  }
}

/** ekko 只存绝对路径，没有文件大小；sizeBytes 给 0，时间用记录时间。 */
function figureEntry(figure: ResearchFigure) {
  return {
    name: figure.name || figure.path.split(/[\\/]/).pop() || figure.path,
    relPath: figure.path,
    sizeBytes: 0,
    mtimeMs: figure.at,
    ...(figure.caption ? { caption: figure.caption } : {}),
  }
}

function serverRecord(server: ResearchServer) {
  return {
    id: server.id,
    name: server.user ? `${server.user}@${server.host}` : server.host,
    host: server.host,
    port: server.port,
    username: server.user,
    note: server.note,
    tags: [] as string[],
    createdAt: isoOf(server.lastCheckedAt),
    updatedAt: isoOf(server.lastCheckedAt),
  }
}

/** ekko 的 ccfddl 行（一个届次）→ 上游的系列卡片；key 与关注列表同一套派生规则。 */
function venueKeyOf(name: string, fallback: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-') || fallback
}

function venueCatalogView(item: VenueDeadline) {
  const key = venueKeyOf(item.name, item.key.toLowerCase())
  const rank = item.ccf === 'A' || item.ccf === 'B' || item.ccf === 'C' ? item.ccf : 'N'
  const parsed = item.deadline ? new Date(`${item.deadline}T00:00:00.000Z`) : null
  const iso = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null
  const year = Number(item.year)
  return {
    key,
    title: item.name,
    description: item.fullName,
    sub: item.field,
    ccfRank: rank,
    dblp: null,
    conf: {
      year: Number.isFinite(year) && year > 0
        ? year
        : (iso === null ? new Date().getUTCFullYear() : new Date(iso).getUTCFullYear()),
      id: item.key,
      link: item.link,
      date: '',
      place: item.place,
      timeline: iso === null ? [] : [{ abstractDeadline: null, deadline: iso, comment: null }],
    },
    nextDeadlineAt: iso,
    nextDeadlineKind: iso === null ? null : 'paper',
  }
}

function jobRecord(job: ResearchJob) {
  return {
    id: job.id,
    serverId: job.serverId,
    command: job.command,
    status: job.state,
    exitCode: job.exitCode,
    stdoutTail: '',
    stderrTail: '',
    createdAt: isoOf(job.submittedAt),
    ...(job.endedAt ? { finishedAt: isoOf(job.endedAt) } : {}),
  }
}

/** 上游的 arXiv 条目（authors 是数组、id 无前缀）。 */
function arxivView(entry: EkkoArxivEntry) {
  return {
    id: entry.arxivId,
    title: entry.title,
    authors: splitAuthors(entry.authors),
    summary: entry.summary,
    published: entry.published,
    url: entry.url,
  }
}

/** 反向：上游条目 → ekko 的导入载荷。 */
function arxivInput(entry: { id: string; title: string; authors: readonly string[]; summary: string; published: string; url: string }) {
  return {
    arxivId: entry.id,
    title: entry.title,
    authors: entry.authors.join(', '),
    year: (entry.published || '').slice(0, 4),
    venue: 'arXiv',
    doi: '',
    url: entry.url,
    summary: entry.summary,
    published: entry.published,
  } satisfies EkkoArxivEntry
}

/** ekko 的订阅只存 seenIds，没有缓存条目详情，所以 newEntries 只能是空数组。 */
function subscriptionView(subscription: ResearchSubscription) {
  return {
    id: subscription.id,
    query: subscription.query,
    createdAt: isoOf(subscription.lastCheckedAt),
    lastCheckedAt: subscription.lastCheckedAt ? isoOf(subscription.lastCheckedAt) : null,
    newEntries: [] as unknown[],
  }
}

/* ------------------------------------------------------------ the remote */

type Async = (...args: never[]) => Promise<unknown>

function listProjects(): Promise<Carried<Business<{ projects: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    return carried(ok({ projects: store.projects.map(project => projectView(store, project)) }))
  })
}

function getPaperOutline(request: { projectId: string }): Promise<Carried<Business<{ projectId: string; nodes: readonly unknown[] }>>> {
  return guard(async () => {
    const paper = await fetchPaperSource(request.projectId)
    return carried(ok({ projectId: request.projectId, nodes: paper.outline }))
  })
}

function saveExperiment(request: { experiment: Record<string, unknown> & { id?: string } }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const { id, ...rest } = request.experiment
    const stored = typeof id === 'string' && id !== ''
      ? await updateResearchItem<{ id: string } & Record<string, unknown>>('experiments', id, rest)
      : await createResearchItem<{ id: string } & Record<string, unknown>>('experiments', rest)
    // The store drops blank optional fields; the view expects the list shape.
    return carried(ok({ experiment: experimentRecord(fillExperiment(stored)) }))
  })
}

function updateExperiment(request: { id: string; serverId?: string | null }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const stored = await updateResearchItem<{ id: string } & Record<string, unknown>>('experiments', request.id, { serverId: request.serverId ?? null })
    return carried(ok({ experiment: experimentRecord(fillExperiment(stored)) }))
  })
}

function deleteExperiment(request: { id: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    await deleteResearchItem('experiments', request.id)
    return carried(ok({}))
  })
}

function readArtifact(request: { projectId: string; name: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchResearchArtifact(request.projectId, request.name))))
}

function getWorktree(): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchLedgerWorktree())))
}

function getForaging(): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchLedgerForaging())))
}

function getMomentIndex(): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchLedgerMoments())))
}

function getEvidenceGraph(): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchLedgerEvidence())))
}

function generateDigest(options: { tier?: string; since?: string; until?: string; lang?: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchLedgerDigest(options))))
}

function checkZotero(): Promise<Carried<Business<unknown>>> {
  return guard(async () => carried(ok(await fetchZoteroStatus())))
}

/** Zotero 的四类失败：没配凭据、参数不行、条目不存在、上游 HTTP。 */
function zoteroFailure(error: unknown): Carried<Business<never>> {
  const code = (error as { code?: unknown })?.code
  if (code === 'unconfigured') {
    return businessFailed('invalid-input', 'Zotero 还没配置：在研究根目录的 zotero.json 里写 apiKey 与 userId')
  }
  const message = error instanceof Error ? error.message : String(error)
  return businessFailed(typeof code === 'string' ? code : 'operation-failed', message)
}

function listZoteroCollections(): Promise<Carried<Business<{ collections: readonly unknown[] }>>> {
  return guard(async () => {
    try {
      return carried(ok({ collections: await fetchZoteroCollections() }))
    } catch (error) {
      return zoteroFailure(error)
    }
  })
}

function searchZotero(request: {
  query: string
  maxResults?: number
}): Promise<Carried<Business<{ results: readonly unknown[] }>>> {
  return guard(async () => {
    const query = request.query.trim()
    if (query === '') return businessFailed('invalid-input', '检索词不能为空')
    try {
      return carried(ok({ results: await searchZoteroItems(query, request.maxResults) }))
    } catch (error) {
      return zoteroFailure(error)
    }
  })
}

/**
 * 导入一条 Zotero 文献：ekko 的 papers 挂在项目下，所以先落项目（面板给的或当前
 * 选中的那个），再按 arXiv id / `zotero-<key>` 做 upsert。
 */
function importZoteroItem(request: {
  key: string
  projectId?: string
}): Promise<Carried<Business<{ imported: boolean; paperId: string }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const projectId = projectOf(store, request.projectId)
    if (!projectId) return businessFailed('invalid-input', '先选中一个项目')
    try {
      return carried(ok(await importZoteroPaper(projectId, request.key)))
    } catch (error) {
      return zoteroFailure(error)
    }
  })
}

/** 把一个 Zotero 分类的 BibTeX 并进项目的 `references.bib`（已存在的键跳过）。 */
function exportZoteroCollectionToBib(request: {
  projectId: string
  collectionKey: string
}): Promise<Carried<Business<{ added: readonly string[]; skipped: readonly string[] }>>> {
  return guard(async () => {
    try {
      return carried(ok(await importZoteroCollectionBib(request.projectId, request.collectionKey)))
    } catch (error) {
      return zoteroFailure(error)
    }
  })
}

function getCompileStatus(request: { projectId: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const { status, last } = await fetchCompileSummary(request.projectId)
    return carried(ok(compileView(status, last)))
  })
}

function getPaperSource(request: { projectId: string }): Promise<Carried<Business<{ content: string; mtimeMs: number }>>> {
  return guard(async () => {
    const paper = await fetchPaperSource(request.projectId)
    return carried(ok({ content: paper.source, mtimeMs: paper.updatedAt }))
  })
}

function saveSource(request: { projectId: string; content: string }): Promise<Carried<Business<{ mtimeMs: number }>>> {
  return guard(async () => {
    const paper = await savePaperSource(request.projectId, request.content)
    return carried(ok({ mtimeMs: paper.updatedAt }))
  })
}

/* --------------------------------------------------------- 章节重排 */

function sameTitles(current: readonly string[], base: readonly string[]): boolean {
  return current.length === base.length && current.every((title, index) => title === base[index])
}

function sameSectionTree(
  current: readonly { title: string; subsections: readonly string[] }[],
  base: readonly { title: string; subsections: readonly string[] }[],
): boolean {
  if (current.length !== base.length) return false
  return current.every((section, index) => {
    const other = base[index]
    if (other === undefined || section.title !== other.title) return false
    return sameTitles(section.subsections, other.subsections)
  })
}

/**
 * 重排顶层 section：先在本地解析拖拽基准，与源码现状比对（不一致就报 conflict，
 * 面板会重新读一遍），再用行置换拼回、整份写回。
 */
function reorderPaperSections(request: {
  projectId: string
  moves: readonly TexSectionMove[]
  baseOutline: readonly string[]
}): Promise<Carried<Business<{ mtimeMs: number }>>> {
  return guard(async () => {
    const paper = await fetchPaperSource(request.projectId)
    const current = sectionTitles(paper.source)
    if (!sameTitles(current, request.baseOutline)) {
      return businessFailed('conflict', '拖动期间源码被改过了，已重新读取，请再拖一次')
    }
    const outcome = reorderSections(paper.source, request.moves)
    if (!outcome.ok) return businessFailed(outcome.code, outcome.message)
    if (outcome.tex === paper.source) return carried(ok({ mtimeMs: paper.updatedAt }))
    const saved = await savePaperSource(request.projectId, outcome.tex)
    return carried(ok({ mtimeMs: saved.updatedAt }))
  })
}

/** 重排 subsection（可跨 section）；冲突判定按"section + 直接子标题"的整棵树。 */
function reorderPaperSubsections(request: {
  projectId: string
  moves: readonly TexSubsectionMove[]
  baseOutline: readonly { title: string; subsections: readonly string[] }[]
}): Promise<Carried<Business<{ mtimeMs: number }>>> {
  return guard(async () => {
    const paper = await fetchPaperSource(request.projectId)
    if (!sameSectionTree(sectionTreeTitles(paper.source), request.baseOutline)) {
      return businessFailed('conflict', '拖动期间源码被改过了，已重新读取，请再拖一次')
    }
    const outcome = reorderSubsections(paper.source, request.moves)
    if (!outcome.ok) return businessFailed(outcome.code, outcome.message)
    if (outcome.tex === paper.source) return carried(ok({ mtimeMs: paper.updatedAt }))
    const saved = await savePaperSource(request.projectId, outcome.tex)
    return carried(ok({ mtimeMs: saved.updatedAt }))
  })
}

function compile(request: { projectId: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const { result, status } = await compileResearchProject(request.projectId)
    return carried(ok(compileView(status, result)))
  })
}

/**
 * 参考文献：ekko 侧读项目目录下的 `references.bib`（与 main.tex 同目录，latexmk 直接
 * 找得到），解析成上游要的 `{ key, type, fields }` 形状。
 */
function getBibliography(request: { projectId: string }): Promise<Carried<Business<{ entries: unknown[]; mtimeMs: number | null }>>> {
  return guard(async () => {
    const bib = await fetchResearchBibliography(request.projectId)
    return carried(ok({ entries: bib.entries, mtimeMs: bib.mtimeMs }))
  })
}

/**
 * 存参考文献：冲突（别人先写了）翻成业务层的 `conflict`，面板据此冻结编辑器让用户
 * 重载，而不是静默覆盖。其它失败继续按传输层失败上抛。
 */
function saveBibliography(
  request: { projectId: string; entries: unknown[]; baseMtimeMs: number | null },
): Promise<Carried<Business<{ mtimeMs: number }>>> {
  return guard(async () => {
    try {
      const saved = await saveResearchBibliography(
        request.projectId,
        request.entries as Parameters<typeof saveResearchBibliography>[1],
        request.baseMtimeMs,
      )
      return carried(ok({ mtimeMs: saved.mtimeMs }))
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'conflict') return businessFailed('conflict', '参考文献已被其他改动更新')
      if (code === 'bib_not_found') return businessFailed('bib-not-found', '参考文献已被删除')
      throw error
    }
  })
}

/** 写入与跳过的条数，面板拿它在导入按钮上回显 `× N`。 */
function importPapersToBib(request: { projectId: string; arxivIds: string[] }): Promise<Carried<Business<{ added: number; skipped: number }>>> {
  return guard(async () => {
    const counts = await importResearchPapersToBib(request.projectId, request.arxivIds)
    return carried(ok({ added: counts.added, skipped: counts.skipped }))
  })
}

/**
 * 快照列表：ekko 的快照是整份 `main.tex`，这里摊成上游要的
 * `{ id, createdAt, files[], sizeBytes }`，面板据此渲染相对时间与体积。
 */
function listPaperSnapshots(request: { projectId: string }): Promise<Carried<Business<{ snapshots: readonly unknown[] }>>> {
  return guard(async () => {
    const snapshots = await fetchResearchSnapshots(request.projectId)
    return carried(ok({ snapshots }))
  })
}

/** 单个快照的完整内容，供面板做 diff。 */
function getPaperSnapshot(request: { projectId: string; id: string }): Promise<Carried<Business<{ id: string; files: readonly { path: string; content: string }[] }>>> {
  return guard(async () => {
    const detail = await fetchResearchSnapshotContent(request.projectId, request.id)
    return carried(ok(detail))
  })
}

/**
 * 回滚到快照。带 `baseMtimeMs` 走服务端的乐观并发；冲突翻成业务层的 `conflict`，
 * 面板会重新载入源码而不是把用户的改动静默覆盖掉。
 */
function revertPaperSnapshot(
  request: { projectId: string; id: string; baseMtimeMs: number | null },
): Promise<Carried<Business<{ mtimeMs: number }>>> {
  return guard(async () => {
    try {
      const saved = await revertResearchPaperSnapshot(request.projectId, request.id, request.baseMtimeMs)
      return carried(ok({ mtimeMs: saved.mtimeMs }))
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'conflict') return businessFailed('conflict', '源码已被其他改动更新')
      if (code === 'paper_not_found') return businessFailed('paper-not-found', '还没有 main.tex 可回滚')
      throw error
    }
  })
}

function createProject(request: { title: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const project = await createResearchProject(request.title)
    const { store } = await fetchResearchState()
    // The controller reads `result.value.project`; returning the bare view made
    // `.title` throw and left the new project unselected.
    return carried(ok({ project: projectView(store, project) }))
  })
}

function renameProject(request: { projectId: string; title: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const project = await renameResearchProject(request.projectId, request.title)
    const { store } = await fetchResearchState()
    return carried(ok({ project: projectView(store, project) }))
  })
}

function deleteProject(request: { projectId: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    await deleteResearchProject(request.projectId)
    return carried(ok({ projectId: request.projectId }))
  })
}

/**
 * 认知简报：和进展报告同一份 change log，但看的是「节奏与分布」而不是逐条流水。
 * 上游还要求 `questions`（边界确认卡）；ekko 没有 L2 判定记录，先交空数组，
 * 把要确认的点写进 Markdown，避免凭空生成「待裁决」卡片。
 */
function generateBrief(request: {
  projectId?: string
  since?: string
  until?: string
}): Promise<Carried<Business<{
  markdown: string
  generatedAt: string
  eventCount: number
  derivationVersion: number
  questions: readonly unknown[]
}>>> {
  return guard(async () => {
    const changes = await fetchResearchChangeLog({
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.since ? { since: request.since } : {}),
      ...(request.until ? { until: request.until } : {}),
      limit: 500,
      order: 'asc',
    })
    const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
    const bucket = new Map<string, number>()
    for (const change of changes) {
      const key = (change.reason || 'research.updated').split('.')[0] || 'research'
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
    const distribution = [...bucket.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `- ${key}：${count} 次`)
    const busiest = [...bucket.entries()].sort((a, b) => b[1] - a[1])[0]
    const markdown = [
      '# 认知简报',
      '',
      `> 范围：${request.projectId ? '当前项目' : '全部项目'} · 窗口：`
        + `${request.since ? stamp(Date.parse(request.since)) : '不限'} → `
        + `${request.until ? stamp(Date.parse(request.until)) : stamp(Date.now())}`
        + ` · 事件 ${changes.length} 条 · 生成于 ${stamp(Date.now())}`,
      '',
      '## 这段时间的动作分布',
      '',
      ...(distribution.length > 0 ? distribution : ['- 窗口内没有记录']),
      '',
      '## 三个观察',
      '',
      busiest
        ? `- 重心在 **${busiest[0]}**（${busiest[1]} 次）：如果它不是当前最关键的那条线，说明注意力被别处牵着。`
        : '- 没有可观察的变更，先从一个具体问题开始，而不是先搭工具。',
      `- 窗口内平均每天 ${(changes.length / 7).toFixed(1)} 次记录（按 7 天折算）；低于 1 次通常意味着在憋大招或停摆，两者都值得确认。`,
      '- 记录里只有「动作」，没有「结论」：结论要写进实验日志或论文源码，否则下一轮读不到。',
      '',
      '## 待你确认',
      '',
      '- 这段时间最想保留的一条线索是什么？把它设为主线，其余线自然退到支线。',
      '- 有没有一条线其实已经失败？给它一个一句话理由，归档成「有据的 No」。',
      '',
    ].join('\n')
    return carried(ok({
      markdown,
      generatedAt: new Date().toISOString(),
      eventCount: changes.length,
      derivationVersion: 1,
      questions: [],
    }))
  })
}

/* ---------------------------------------------------------- 顿悟 & 瞬间 */

/** 钉住 / 不采纳一个瞬间（标记落库，索引视图下一次读取就带上）。 */
function pinMoment(request: {
  targetEventId: string
  note?: string
  pinned?: boolean
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const saved = await pinResearchMoment(request.targetEventId, {
      ...(typeof request.note === 'string' ? { note: request.note } : {}),
      pinned: request.pinned !== false,
    })
    return carried(ok(saved))
  })
}

/** 宣告一次顿悟（写进 eurekas，证据图会把它标成强调点）。 */
function setEureka(request: {
  ideaId?: string
  projectId?: string
  title: string
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    if (request.title.trim() === '') return businessFailed('invalid-input', '顿悟标题不能为空')
    const saved = await declareResearchEureka({
      title: request.title,
      ...(typeof request.ideaId === 'string' && request.ideaId !== '' ? { ideaId: request.ideaId } : {}),
      ...(typeof request.projectId === 'string' && request.projectId !== '' ? { projectId: request.projectId } : {}),
    })
    return carried(ok(saved))
  })
}

/** 读回已宣告的顿悟（证据图的强调节点用 `declarations`）。 */
function getEurekaView(): Promise<Carried<Business<{ declarations: readonly unknown[] }>>> {
  return guard(async () => {
    const view = await fetchResearchEureka()
    // 上游以 `lineId === null` 表示「未归属」，undefined 会让布局层直接崩。
    const declarations = (view.declarations ?? []).map(item => ({ ...item, lineId: item.lineId ?? null }))
    return carried(ok({ declarations }))
  })
}

/* ------------------------------------------------ 期刊条目 / 证据边 */

/** 写入类失败的统一翻译：参数问题落业务失败，其余透传 code。 */
function writeFailure(error: unknown): Carried<Business<never>> {
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'invalid_request') return businessFailed('invalid-input', message)
  return businessFailed(typeof code === 'string' ? code : 'operation-failed', message)
}

/**
 * 写一条手记。ekko 的 store 里没有"日志"表，服务端把它落成一条 `journal` 行，
 * 并回一个上游 `EventRecord` 形状的结果（面板的时间线直接用这个）。
 */
function addJournalEntry(request: {
  text: string
  projectId?: string
  ideaId?: string
  valence?: number
  arousal?: number
  question?: { kind: string; lineId: string }
}): Promise<Carried<Business<{ event: unknown }>>> {
  return guard(async () => {
    const text = request.text.trim()
    if (text === '') return businessFailed('invalid-input', '这一条不能是空的')
    const { store } = await fetchResearchState()
    const projectId = projectOf(store, request.projectId)
    try {
      const saved = await writeJournalEntry({
        text,
        ...(projectId === '' ? {} : { projectId }),
        ...(typeof request.ideaId === 'string' && request.ideaId !== '' ? { ideaId: bareIdeaId(request.ideaId) } : {}),
        ...(typeof request.valence === 'number' ? { valence: request.valence } : {}),
        ...(typeof request.arousal === 'number' ? { arousal: request.arousal } : {}),
        ...(request.question === undefined ? {} : { question: request.question }),
      })
      return carried(ok({ event: saved.event }))
    } catch (error) {
      return writeFailure(error)
    }
  })
}

/** 断言一条证据边；同样的 (rel, src, dst) 天然幂等。 */
function addEvidenceEdge(request: {
  rel: string
  src: string
  dst: string
  srcLabel?: string
  dstLabel?: string
  note?: string
  projectId?: string
  ideaId?: string
  claimId?: string
}): Promise<Carried<Business<{ dedupKey: string; rel: string; src: string; dst: string }>>> {
  return guard(async () => {
    const src = request.src.trim()
    const dst = request.dst.trim()
    if (src === '' || dst === '') return businessFailed('invalid-input', '边的两端不能为空')
    try {
      const saved = await declareEvidenceEdge({
        rel: request.rel.trim(),
        src,
        dst,
        ...(request.srcLabel === undefined ? {} : { srcLabel: request.srcLabel }),
        ...(request.dstLabel === undefined ? {} : { dstLabel: request.dstLabel }),
        ...(request.note === undefined ? {} : { note: request.note }),
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.ideaId === undefined ? {} : { ideaId: bareIdeaId(request.ideaId) }),
        ...(request.claimId === undefined ? {} : { claimId: request.claimId }),
      })
      return carried(ok(saved))
    } catch (error) {
      return writeFailure(error)
    }
  })
}

/** 按 dedupKey 撤回一条证据边（覆盖它的全部重复声明）。 */
function retractEvidenceEdge(request: {
  dedupKey: string
  reason?: string
  projectId?: string
  ideaId?: string
  claimId?: string
}): Promise<Carried<Business<{ dedupKey: string }>>> {
  return guard(async () => {
    if (request.dedupKey.trim() === '') return businessFailed('invalid-input', '缺少 dedupKey')
    try {
      return carried(ok(await retractEvidenceEdgeApi({
        dedupKey: request.dedupKey,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.ideaId === undefined ? {} : { ideaId: request.ideaId }),
        ...(request.claimId === undefined ? {} : { claimId: request.claimId }),
      })))
    } catch (error) {
      return writeFailure(error)
    }
  })
}

/** 抓一篇论文的 PDF 到项目目录，回带 `pdfPath` 的记录。 */
function fetchPaperPdf(request: { arxivId: string }): Promise<Carried<Business<{ paper: unknown }>>> {
  return guard(async () => {
    const arxivId = request.arxivId.trim()
    if (arxivId === '') return businessFailed('invalid-input', '缺少 arXiv id')
    const { store } = await fetchResearchState()
    const projectId = projectOf(store)
    if (!projectId) return businessFailed('invalid-input', '先选中一个项目')
    try {
      const result = await fetchResearchPaperPdf(projectId, arxivId)
      return carried(ok({ paper: paperRecord(result.paper) }))
    } catch (error) {
      return writeFailure(error)
    }
  })
}

/** 把一个已有的 LaTeX 目录复制进来注册成项目（服务端只复制、不引用）。 */
function importProject(request: { path: string; title?: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const path = request.path.trim()
    if (path === '') return businessFailed('invalid-input', '请填源目录路径')
    try {
      const imported = await importResearchProject(
        path,
        request.title === undefined || request.title.trim() === '' ? undefined : request.title.trim(),
      )
      return carried(ok(imported))
    } catch (error) {
      return writeFailure(error)
    }
  })
}

/* ------------------------------------------------------- 网页检索与设置 */

/** 参数错误落成业务失败（面板显示原因），其余按上游给的 code 透传。 */
function settingsFailure(error: unknown): Carried<Business<never>> {
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)
  const known = typeof code === 'string' && code !== 'invalid_request' ? code : 'invalid-input'
  return businessFailed(known, message)
}

/**
 * 网页检索：走研究设置里配置的 SearXNG 实例（`/search?format=json`）。
 * 没配 baseUrl 时如实回业务失败，而不是装作搜过。
 */
function searchWeb(request: {
  query: string
  maxResults?: number
  categories?: string
  lang?: string
}): Promise<Carried<Business<{ results: readonly unknown[] }>>> {
  return guard(async () => {
    const query = request.query.trim()
    if (query === '') return businessFailed('invalid-input', '检索词不能为空')
    try {
      const results = await searchWebResearch(query, {
        ...(typeof request.maxResults === 'number' ? { maxResults: request.maxResults } : {}),
        ...(typeof request.categories === 'string' && request.categories !== '' ? { categories: request.categories } : {}),
        ...(typeof request.lang === 'string' && request.lang !== '' ? { lang: request.lang } : {}),
      })
      return carried(ok({ results }))
    } catch (error) {
      return settingsFailure(error)
    }
  })
}

function getImageGenConfig(): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    try {
      return carried(ok(await fetchImageGenConfig()))
    } catch (error) {
      return settingsFailure(error)
    }
  })
}

function setImageGenConfig(request: {
  baseUrl?: string
  apiKey?: string
  model?: string
  size?: string
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const patch: { baseUrl?: string; apiKey?: string; model?: string; size?: string } = {}
    if (typeof request.baseUrl === 'string') patch.baseUrl = request.baseUrl
    if (typeof request.apiKey === 'string') patch.apiKey = request.apiKey
    if (typeof request.model === 'string') patch.model = request.model
    if (typeof request.size === 'string') patch.size = request.size
    if (Object.keys(patch).length === 0) return carried(ok(await fetchImageGenConfig()))
    try {
      return carried(ok(await saveImageGenConfig(patch)))
    } catch (error) {
      return settingsFailure(error)
    }
  })
}

function getSxngConfig(): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    try {
      return carried(ok(await fetchSxngConfig()))
    } catch (error) {
      return settingsFailure(error)
    }
  })
}

function setSxngConfig(request: {
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
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const patch: Parameters<typeof saveSxngConfig>[0] = {}
    if (typeof request.baseUrl === 'string') patch.baseUrl = request.baseUrl
    if (typeof request.defaultEngine === 'string') patch.defaultEngine = request.defaultEngine
    if (Array.isArray(request.allowedEngines)) patch.allowedEngines = [...request.allowedEngines]
    if (typeof request.defaultLimit === 'number') patch.defaultLimit = request.defaultLimit
    if (request.defaultFormat === 'md' || request.defaultFormat === 'json') patch.defaultFormat = request.defaultFormat
    if (typeof request.useProxy === 'boolean') patch.useProxy = request.useProxy
    if (typeof request.proxyUrl === 'string') patch.proxyUrl = request.proxyUrl
    if (typeof request.timeout === 'number') patch.timeout = request.timeout
    if (typeof request.ollamaApiKey === 'string') patch.ollamaApiKey = request.ollamaApiKey
    if (typeof request.redundancyThreshold === 'number') patch.redundancyThreshold = request.redundancyThreshold
    if (typeof request.redundancyBigramThreshold === 'number') {
      patch.redundancyBigramThreshold = request.redundancyBigramThreshold
    }
    if (Object.keys(patch).length === 0) return carried(ok(await fetchSxngConfig()))
    try {
      return carried(ok(await saveSxngConfig(patch)))
    } catch (error) {
      return settingsFailure(error)
    }
  })
}

/* ------------------------------------------------------------ 目标会议 */

/**
 * 目标会议/期刊的内置模板：ekko 用 CCF 目录的 A 类条目当「模板清单」
 * （没有 .cls 资产，所以只用来记录目标 + 打开官网链接）。
 */
function listVenueTemplates(): Promise<Carried<Business<{ templates: readonly unknown[] }>>> {
  return guard(async () => {
    const templates = await fetchVenueTemplates()
    return carried(ok({ templates }))
  })
}

/** 记录一个项目的目标会议（内置条目或自定义名称），不改写 main.tex。 */
function applyVenueTemplate(request: {
  projectId: string
  templateId?: string
  customName?: string
}): Promise<Carried<Business<{ venue: unknown; warnings: readonly string[] }>>> {
  return guard(async () => {
    const result = await applyResearchVenue(request.projectId, {
      ...(typeof request.templateId === 'string' && request.templateId !== ''
        ? { templateId: request.templateId }
        : {}),
      ...(typeof request.customName === 'string' && request.customName !== ''
        ? { customName: request.customName }
        : {}),
    })
    return carried(ok({ venue: result.venue, warnings: result.warnings ?? [] }))
  })
}

/** 清掉项目的目标会议。 */
function clearVenueTemplate(request: { projectId: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    await clearResearchVenue(request.projectId)
    return carried(ok({ venue: null }))
  })
}

/**
 * 订阅/取消订阅一个会议系列的截稿提醒。
 *
 * ekko 侧没有独立的 watch 表：`venues` 里挂在这个项目下的一行就是"在看"，系列键
 * 与 `listVenueDeadlines` 的 `watched` 用同一个归一化规则，所以勾选状态能对得上。
 */
function setVenueWatch(request: {
  projectId: string
  series: string
  watched: boolean
}): Promise<Carried<Business<{ projectId: string; series: string; watched: boolean }>>> {
  return guard(async () => {
    const series = request.series.trim()
    if (series === '') return businessFailed('invalid-input', '缺少会议 series')
    const { store } = await fetchResearchState()
    const rows = store.venues.filter(item => item.projectId === request.projectId
      && venueKeyOf(item.name, item.id) === series)
    if (!request.watched) {
      await Promise.all(rows.map(row => deleteResearchItem('venues', row.id)))
      return carried(ok({ projectId: request.projectId, series, watched: false }))
    }
    if (rows.length === 0) {
      await createResearchItem<ResearchVenue>('venues', {
        projectId: request.projectId,
        name: series,
        ccf: '',
        deadline: '',
        starred: true,
      })
    }
    return carried(ok({ projectId: request.projectId, series, watched: true }))
  })
}

/* ------------------------------------------------------------ wiki 迁移 */

/** 导出当前研究库为 `mimir-wiki` v3 快照（导入向导按这个格式校验）。 */
function exportWiki(): Promise<Carried<Business<{ snapshot: unknown }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const snapshot = {
      format: 'mimir-wiki',
      version: 3,
      exportedAt: new Date().toISOString(),
      tables: {
        papers: store.papers,
        ideas: store.ideas,
        claims: [],
        projects: store.projects,
        experiments: store.experiments,
        servers: store.servers,
      },
    }
    return carried(ok({ snapshot }))
  })
}

/** 导入一份 `mimir-wiki` 快照；主机逐表按 id 去重写入。 */
function importWiki(request: {
  snapshot: unknown
  mode: string
  confirmReplace?: boolean
}): Promise<Carried<Business<{ imported: Record<string, number>; skipped: Record<string, number> }>>> {
  return guard(async () => {
    const counts = await importResearchWiki(
      request.snapshot,
      request.mode === 'replace' ? 'replace' : 'merge',
      request.confirmReplace === true,
    )
    return carried(ok(counts))
  })
}

/* ------------------------------------------------------------ 工作树动作 */

/**
 * 视图层拿的是 lane 的 `lineId`（`idea:<id>` / `project:<id>`），服务端要裸 id。
 * `setMainline` 在控制器里已剥 `project:` 前缀但没剥 `idea:`，这里统一兜一次。
 */
function bareIdeaId(value: string): string {
  return value.startsWith('idea:') ? value.slice('idea:'.length) : value
}

/** 宣告主线：挂在项目线或想法线上，服务端记一条 reflog。 */
function setMainline(request: {
  projectId?: string
  ideaId?: string
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const target = typeof request.projectId === 'string' && request.projectId !== ''
      ? { projectId: request.projectId }
      : { ideaId: bareIdeaId(request.ideaId ?? '') }
    const saved = await setResearchMainline(target)
    return carried(ok({ mainline: saved.mainline }))
  })
}

/** 宣告/清除一条派生关系（子线 ← 父线）。 */
function setIdeaParent(request: {
  ideaId: string
  parentIdeaId?: string | null
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const parent = request.parentIdeaId === null || request.parentIdeaId === undefined || request.parentIdeaId === ''
      ? null
      : bareIdeaId(request.parentIdeaId)
    const saved = await setResearchIdeaParent(bareIdeaId(request.ideaId), parent)
    return carried(ok({ idea: saved.idea }))
  })
}

/** 并入一条想法线（kind: idea → decision）。 */
function adoptIdea(request: { ideaId: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const saved = await adoptResearchIdea(bareIdeaId(request.ideaId))
    return carried(ok({ idea: saved.idea }))
  })
}

/** 关闭一条想法线并留下理由（有据的 No）。 */
function closeIdea(request: { ideaId: string; reason: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    if (request.reason.trim() === '') return businessFailed('invalid-input', '关闭理由不能为空')
    const saved = await closeResearchIdea(bareIdeaId(request.ideaId), request.reason)
    return carried(ok({ idea: saved.idea }))
  })
}

/* ---------------------------------------------------------------- 图表 */

/**
 * 找一张图片的记录：按绝对路径、路径后缀或文件名（面板给的是 relPath）。
 *
 * 内联编辑器的「保存」会先用旧文件名重命名、再用同一个旧 relPath 写描述，
 * 所以精确匹配落空时按「文件名主干」再找一次：同主干唯一命中才算数，
 * 避免 a.png / a-1.png 这种前缀相撞时误改别的记录。
 */
function figureOf(store: ResearchStore, projectId: string, relPath: string): ResearchFigure | undefined {
  const name = relPath.split(/[\\/]/).pop() || ''
  const mine = store.figures.filter(item => item.projectId === projectId)
  const exact = mine.find(item => item.path === relPath || item.path.endsWith(relPath) || item.name === name)
  if (exact) return exact
  const stemOf = (value: string): string => (value.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '')
  const stem = stemOf(relPath)
  if (stem === '') return undefined
  const sameStem = mine.filter(item => stemOf(item.path) === stem)
  if (sameStem.length === 1) return sameStem[0]
  const renamed = mine.filter(item => stemOf(item.path).startsWith(`${stem}-`))
  return renamed.length === 1 ? renamed[0] : undefined
}

/** 重命名一张图片：服务端改名落盘并同步记录。 */
function renameFigure(request: {
  projectId: string
  relPath: string
  newName: string
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const moved = await renameResearchFigure(request.projectId, request.relPath, request.newName)
    return carried(ok({ figure: { path: moved.path, name: moved.name } }))
  })
}

/** 删除一张图片：文件和记录一起删。 */
function deleteFigure(request: { projectId: string; relPath: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    await deleteResearchFigure(request.projectId, request.relPath)
    return carried(ok({ relPath: request.relPath }))
  })
}

/** 改一张图片的说明：只动记录里的 caption。 */
function updateFigure(request: {
  projectId: string
  relPath: string
  caption: string
}): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const figure = figureOf(store, request.projectId, request.relPath)
    if (!figure) return businessFailed('figure-not-found', `找不到图片记录：${request.relPath}`)
    await updateResearchItem<{ id: string } & Record<string, unknown>>('figures', figure.id, { caption: request.caption })
    return carried(ok({ id: figure.id, caption: request.caption }))
  })
}

/** 面板给的图名 → 上传用的 MIME（未知类型交给服务端按扩展名判断）。 */
function figureContentType(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

/**
 * 保存客户端生成的图（实验视图的指标对比 SVG）：写进项目目录、登记记录、
 * 顺手转一份可嵌入 LaTeX 的产物。转不了不算失败 —— 图已经落盘了，只回 warning。
 */
function saveFigure(request: {
  projectId: string
  name: string
  content: string
  caption?: string
  dir?: string
}): Promise<Carried<Business<{
  relPath: string
  caption: string
  converted?: { relPath: string; converter: string }
  warning?: string
}>>> {
  return guard(async () => {
    const name = request.name.trim()
    if (name === '') return businessFailed('invalid-input', '图片文件名不能为空')
    if (request.content.trim() === '') return businessFailed('invalid-input', '图片内容为空')
    const file = new File([request.content], name, { type: figureContentType(name) })
    const uploaded = await uploadResearchFigure(request.projectId, file, request.dir)
    let caption = uploaded.figure.caption ?? ''
    const wanted = (request.caption ?? '').trim()
    if (wanted !== '' && wanted !== caption) {
      await updateResearchItem<{ id: string } & Record<string, unknown>>('figures', uploaded.figure.id, { caption: wanted })
      caption = wanted
    }
    try {
      const converted = await convertResearchFigure(request.projectId, uploaded.relPath)
      return carried(ok({ relPath: uploaded.relPath, caption, converted }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return carried(ok({ relPath: uploaded.relPath, caption, warning: `已保存，但没生成可嵌入的 PDF：${reason}` }))
    }
  })
}

/** 把一张图转成可嵌入 LaTeX 的产物；本机没有转换器时如实回业务失败。 */
function convertFigure(request: {
  projectId: string
  relPath: string
}): Promise<Carried<Business<{ relPath: string; converter: string }>>> {
  return guard(async () => {
    try {
      const converted = await convertResearchFigure(request.projectId, request.relPath)
      return carried(ok(converted))
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      const reason = error instanceof Error ? error.message : String(error)
      if (code === 'no_converter') {
        return businessFailed('no-converter', '这台机器上没有 SVG→PDF 转换器（rsvg-convert），装好之后可重试')
      }
      return businessFailed(typeof code === 'string' ? code : 'convert-failed', reason)
    }
  })
}

/**
 * 进展报告：ekko 的 change log 就是这份「谁改了什么」的原始记录，按窗口取出来
 * 直接排成 Markdown。项目维度暂无字段（`events.jsonl` 只记动作与时间），
 * 所以报告头会写明统计范围，避免读者误以为是单项目。
 */
function generateProgressReport(request: {
  projectId?: string
  since?: string
  until?: string
}): Promise<Carried<Business<{ markdown: string; generatedAt: string; eventCount: number }>>> {
  return guard(async () => {
    const changes = await fetchResearchChangeLog({
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.since ? { since: request.since } : {}),
      ...(request.until ? { until: request.until } : {}),
      limit: 500,
      order: 'asc',
    })
    const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
    const generatedAt = new Date().toISOString()
    const scope = request.projectId ? '当前项目' : '全部项目'
    const rows = changes.map(change => `| ${stamp(change.at)} | ${change.reason || 'research.updated'} |`)
    const markdown = [
      '# 科研进展报告',
      '',
      `> 范围：${scope} · 窗口：${request.since ? stamp(Date.parse(request.since)) : '不限'} → `
        + `${request.until ? stamp(Date.parse(request.until)) : stamp(Date.now())}`
        + ` · 事件 ${changes.length} 条 · 生成于 ${stamp(Date.now())}`,
      '',
      '## 变更时间线',
      '',
      '| 时间 | 动作 |',
      '| --- | --- |',
      ...(rows.length > 0 ? rows : ['| — | 该窗口没有记录 |']),
      '',
      '## 下一步建议',
      '',
      '- 把窗口内的 `experiments.*` 变更逐条对照结论，补上量化指标。',
      '- 新导入的文献 3 天内写一段阅读笔记，避免「收了没读」。',
      '- 图表有改动就重跑一次编译，确认预览仍是当前版本。',
      '',
    ].join('\n')
    return carried(ok({ markdown, generatedAt, eventCount: changes.length }))
  })
}

/* ------------------------------------------------------- 组会 & 成长记录 */

/**
 * 已生成的组会汇报：列表来自服务端新的 `GET /projects/:id/decks`（含磁盘大小）。
 * 每个 deck 的 markdown 用已鉴权客户端取回来登记成 object URL，上游的
 * `<a download>` 才有可下载的地址。
 */
function listMeetingDecks(request: { projectId: string }): Promise<Carried<Business<{ decks: readonly unknown[] }>>> {
  return guard(async () => {
    const items = await fetchResearchDecks(request.projectId)
    const decks: Array<{ file: string; sizeBytes: number; updatedAt: string }> = []
    for (const item of items) {
      let blob: Blob | null = null
      try {
        // 真正的幻灯片是 pptx 二进制；取回后直接挂成 object URL 供下载。
        blob = await fetchResearchDeckFile(request.projectId, item.id)
      } catch {
        // 文件被手工挪走时列表仍要出现，下载锚点退化为空。
      }
      if (blob !== null) registerDeckBlob(request.projectId, item.file, blob)
      decks.push({ file: item.file, sizeBytes: item.sizeBytes, updatedAt: isoOf(item.at) })
    }
    return carried(ok({ decks }))
  })
}

/** 生成一份组会汇报：ekko 产出 markdown 脚手架（页数来自 store 记录）。 */
function generateMeetingDeck(request: {
  projectId: string
  title?: string
  paperIds?: readonly string[]
}): Promise<Carried<Business<{ slides: number; illustrations: number }>>> {
  return guard(async () => {
    const created = await createResearchDeck(request.projectId, {
      ...(typeof request.title === 'string' && request.title !== '' ? { title: request.title } : {}),
      ...(Array.isArray(request.paperIds)
        ? { paperIds: request.paperIds.filter((id): id is string => typeof id === 'string') }
        : {}),
    })
    const pages = created && created.deck && typeof created.deck.pages === 'number' ? created.deck.pages : 0
    return carried(ok({ slides: pages, illustrations: 0 }))
  })
}

/** 删除一份汇报：面板只给文件名，按名字找到记录再删（文件由服务端一并清理）。 */
function deleteMeetingDeck(request: { projectId: string; file: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const items = await fetchResearchDecks(request.projectId)
    const hit = items.find(item => item.file === request.file)
    if (hit) await deleteResearchItem('decks', hit.id)
    return carried(ok({ file: request.file }))
  })
}

/**
 * 成长记录的事件列表：ekko 的 `events.jsonl` 只记 `{at, revision, reason}`，
 * 这里补成上游 `EventRecord` 的形状（id/ts/action/actor/payload），
 * 视图的时间线、载荷摘要与「谁改的」都按这份数据渲染。
 */
function listEvents(request: {
  projectId?: string
  since?: string
  until?: string
  limit?: number
  order?: string
}): Promise<Carried<Business<{ events: readonly unknown[] }>>> {
  return guard(async () => {
    const changes = await fetchResearchChangeLog({
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.since ? { since: request.since } : {}),
      ...(request.until ? { until: request.until } : {}),
      ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
      ...(request.order ? { order: request.order } : {}),
    })
    const events = changes.map((change, index) => ({
      id: change.id ?? `${change.revision}-${index}`,
      ts: change.ts ?? new Date(change.at).toISOString(),
      action: change.action ?? (change.reason || 'research.updated'),
      actor: change.actor ?? { kind: 'system' as const, id: '' },
      refs: change.refs ?? {},
      payload: change.payload ?? ({ revision: change.revision } as Record<string, unknown>),
    }))
    return carried(ok({ events }))
  })
}

/* ---------------------------------------------- 总览要用到的六个列表 */

function listPapers(): Promise<Carried<Business<{ papers: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    return carried(ok({ papers: store.papers.map(paperRecord) }))
  })
}

function listExperiments(request: { projectId?: string }): Promise<Carried<Business<{ experiments: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const rows = request.projectId
      ? store.experiments.filter(item => item.projectId === request.projectId)
      : store.experiments
    return carried(ok({ experiments: rows.map(item => experimentRecord(fillExperiment(item as unknown as Record<string, unknown>))) }))
  })
}

/**
 * 图表同时把图片字节取回来：上游 `<img src>` 带不了 Bearer，适配层用已鉴权的
 * requestBlob 换 object URL 存缓存（figureUrl 会从这里取），顺带就有了真实字节数。
 */
function listFigures(request: { projectId: string }): Promise<Carried<Business<{ figures: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const rows = store.figures.filter(item => item.projectId === request.projectId)
    const figures = await Promise.all(rows.map(async (figure) => {
      const cached = figureBlobEntry(request.projectId, figure.path)
      if (cached && cached.at === figure.at) return { ...figureEntry(figure), sizeBytes: cached.size }
      try {
        const blob = await fetchResearchFigure(request.projectId, figure.path)
        const entry = registerFigureBlob(request.projectId, figure.path, figure.at, blob)
        return { ...figureEntry(figure), sizeBytes: entry.size }
      } catch {
        return figureEntry(figure)
      }
    }))
    return carried(ok({ figures }))
  })
}

function listServers(): Promise<Carried<Business<{ servers: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    return carried(ok({ servers: store.servers.map(serverRecord) }))
  })
}

function listVenueDeadlines(request: { projectId?: string }): Promise<Carried<Business<{
  venues: readonly unknown[]
  journals: readonly unknown[]
  watched: readonly string[]
  fetchedAt: string | null
}>>> {
  return guard(async () => {
    const [state, catalog] = await Promise.all([
      fetchResearchState(),
      fetchVenueCatalog({ limit: 500 }).catch(() => null),
    ])
    const venues = (catalog?.items ?? []).map(venueCatalogView)
    const rows = request.projectId
      ? state.store.venues.filter(item => item.projectId === request.projectId)
      : state.store.venues
    const watched = Array.from(new Set(rows.map(item => venueKeyOf(item.name, item.id)))).sort()
    const fetchedAt = catalog !== null && catalog.fetchedAt ? isoOf(catalog.fetchedAt) : null
    return carried(ok({ venues, journals: CCF_A_JOURNALS, watched, fetchedAt }))
  })
}

/**
 * 「刷新目录」：上游是一次强制抓取，ekko 侧就是带 force 的 catalog 请求。
 * 返回新的抓取时间，UI 收到成功后再重载列表。
 */
function refreshVenueDeadlines(): Promise<Carried<Business<{ fetchedAt: string }>>> {
  return guard(async () => {
    const catalog = await fetchVenueCatalog({ limit: 1, force: true })
    return carried(ok({ fetchedAt: isoOf(catalog.fetchedAt || Date.now()) }))
  })
}

function listJobs(): Promise<Carried<Business<{ jobs: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    return carried(ok({ jobs: store.jobs.map(jobRecord) }))
  })
}

/** ekko 没有定时备份：如实回「未启用」，总览的数据区会显示这行状态。 */
function listBackups(): Promise<Carried<Business<{ backup: unknown }>>> {
  return guard(async () => carried(ok({
    backup: { enabled: false, intervalMinutes: 0, keep: 0, count: 0, latestName: null },
  })))
}

/** ekko 侧没有常驻定时任务，回空数组（面板会隐藏这块）。 */
function getTaskHealth(): Promise<Carried<Business<{ tasks: readonly unknown[] }>>> {
  return guard(async () => carried(ok({ tasks: [] })))
}

/* ------------------------------------------- 订阅 / arXiv 检索 / 文献增删改 */

function listArxivSubscriptions(): Promise<Carried<Business<{ subscriptions: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    return carried(ok({ subscriptions: store.subscriptions.map(subscriptionView) }))
  })
}

function saveArxivSubscription(request: { query: string }): Promise<Carried<Business<{ subscription: unknown }>>> {
  return guard(async () => {
    const query = request.query.trim()
    if (!query) return businessFailed('invalid-input', '订阅查询不能为空')
    const { store } = await fetchResearchState()
    const duplicate = store.subscriptions.find(item => item.query.trim() === query)
    if (duplicate) return businessFailed('invalid-input', '这个查询已经订阅过了')
    const projectId = projectOf(store)
    if (!projectId) return businessFailed('invalid-input', '先选中一个项目')
    const created = await createResearchItem<ResearchSubscription>('subscriptions', {
      projectId,
      query,
      lastCheckedAt: 0,
      seenIds: [],
    })
    return carried(ok({ subscription: subscriptionView(created) }))
  })
}

function deleteArxivSubscription(request: { id: string }): Promise<Carried<Business<{ id: string }>>> {
  return guard(async () => {
    await deleteResearchItem('subscriptions', request.id)
    return carried(ok({ id: request.id }))
  })
}

/** 逐条跑 ekko 的订阅检查；返回每条的新增条目与失败原因。 */
function checkArxivSubscriptions(request: { id?: string }): Promise<Carried<Business<{ checks: readonly unknown[] }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const targets = request.id
      ? store.subscriptions.filter(item => item.id === request.id)
      : store.subscriptions
    const checks = []
    for (const subscription of targets) {
      try {
        const result = await checkResearchSubscription(subscription.id)
        const added = (result.added || []).map(entry => ({
          id: entry.arxivId || entry.id,
          title: entry.title,
          authors: [] as string[],
          summary: '',
          published: '',
          url: entry.arxivId ? `https://arxiv.org/abs/${entry.arxivId}` : '',
        }))
        checks.push({
          subscription: { ...subscriptionView(subscription), lastCheckedAt: isoOf(Date.now()), newEntries: added },
          added,
          error: result.error || null,
        })
      } catch (error) {
        checks.push({
          subscription: subscriptionView(subscription),
          added: [],
          error: error instanceof Error ? error.message : '检查失败',
        })
      }
    }
    return carried(ok({ checks }))
  })
}

function searchArxiv(request: { query: string; maxResults?: number }): Promise<Carried<Business<{ results: readonly unknown[] }>>> {
  return guard(async () => {
    const query = request.query.trim()
    if (!query) return businessFailed('invalid-input', '检索词不能为空')
    const result = await searchArxivResearch(query, request.maxResults ?? 10)
    const results = result.entries.map(arxivView)
    // 后端把 429/超时写进 `error`，只在 `entries` 里没有线索。空结果 + 有 error 必须
    // 如实上报成失败，否则面板一律显示「没有匹配的 arXiv 结果」，把限流伪装成查无结果。
    if (results.length === 0 && result.error !== '') return businessFailed('arxiv-error', result.error)
    return carried(ok({ results }))
  })
}

function importPaper(request: { entry: { id: string; title: string; authors: readonly string[]; summary: string; published: string; url: string }; projectId?: string }): Promise<Carried<Business<{ imported: boolean }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const projectId = projectOf(store, request.projectId ?? null)
    if (!projectId) return businessFailed('invalid-input', '先选中一个项目')
    const result = await importArxivPaper(projectId, arxivInput(request.entry))
    return carried(ok({ imported: !result.duplicate }))
  })
}

function removePaper(request: { arxivId: string }): Promise<Carried<Business<{ arxivId: string }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const paper = store.papers.find(item => item.arxivId === request.arxivId || item.id === request.arxivId)
    if (!paper) return businessFailed('not-found', '这条文献不在工作区里')
    await deleteResearchItem('papers', paper.id)
    return carried(ok({ arxivId: request.arxivId }))
  })
}

/**
 * 控制器的签名是扁平的 `updatePaper(arxivId, patch)`，它调远程时拼成
 * `{ arxivId, ...patch }` —— 这里也必须按扁平收，包一层 `patch` 会取到
 * undefined 并在 `request.patch.notes` 上抛 TypeError（面板只会显示「保存失败」）。
 */
function updatePaper(request: {
  arxivId: string
  notes?: string
  title?: string
  tags?: readonly string[]
  projectIds?: readonly string[]
  score?: number
}): Promise<Carried<Business<{ paper: unknown }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const paper = store.papers.find(item => item.arxivId === request.arxivId || item.id === request.arxivId)
    if (!paper) return businessFailed('not-found', '这条文献不在工作区里')
    const patch: Record<string, unknown> = {}
    if (request.notes !== undefined) patch.notes = request.notes
    if (request.title !== undefined) patch.title = request.title
    /* ekko 的记录本来没有 tags 字段（面板的 chips 是 venue/year/status 派生的），
       这里补一个真正可编辑的标签列表。 */
    if (request.tags !== undefined) patch.tags = [...request.tags]
    if (request.score !== undefined) patch.score = request.score
    /* ekko 一条文献只挂一个项目（单 projectId 字段），多选时取第一个。 */
    if (request.projectIds !== undefined && request.projectIds.length > 0) patch.projectId = request.projectIds[0]
    const updated = Object.keys(patch).length
      ? await updateResearchItem<ResearchPaper>('papers', paper.id, patch)
      : paper
    return carried(ok({ paper: paperRecord(updated) }))
  })
}

/* --------------------------------------------------------- 服务器与任务 */

function saveServer(request: { server: { id?: string; name: string; host: string; port: number; username: string; note: string } }): Promise<Carried<Business<{ server: unknown }>>> {
  return guard(async () => {
    const { store } = await fetchResearchState()
    const input = request.server
    const fields = {
      host: input.host,
      user: input.username,
      port: input.port,
      note: input.note,
    }
    if (input.id) {
      const updated = await updateResearchItem<ResearchServer>('servers', input.id, fields)
      return carried(ok({ server: serverRecord(updated) }))
    }
    const projectId = projectOf(store)
    if (!projectId) return businessFailed('invalid-input', '先选中一个项目')
    const created = await createResearchItem<ResearchServer>('servers', {
      projectId,
      ...fields,
      status: 'unknown',
      lastCheckedAt: 0,
    })
    return carried(ok({ server: serverRecord(created) }))
  })
}

function deleteServer(request: { id: string }): Promise<Carried<Business<{ id: string }>>> {
  return guard(async () => {
    await deleteResearchItem('servers', request.id)
    return carried(ok({ id: request.id }))
  })
}

/** ekko 的探测结果只有 ok/detail；GPU 读数与分段耗时没有对应字段。 */
function checkServer(request: { id: string }): Promise<Carried<Business<unknown>>> {
  return guard(async () => {
    const { probe } = await checkResearchServer(request.id)
    return carried(ok({
      state: probe.status === 'online' && probe.ok ? 'online' : 'offline',
      latencyMs: null,
      gpus: [],
      checkedAt: isoOf(probe.at || Date.now()),
      message: probe.detail || null,
    }))
  })
}

function submitJob(request: { serverId: string; command: string; experimentId?: string; name?: string }): Promise<Carried<Business<{ job: unknown }>>> {
  return guard(async () => {
    const name = (request.name || request.command).slice(0, 60)
    const result = await submitResearchJob(request.serverId, { name, command: request.command })
    return carried(ok({ job: jobRecord(result.job) }))
  })
}

function deleteJob(request: { id: string }): Promise<Carried<Business<{ id: string }>>> {
  return guard(async () => {
    await deleteResearchItem('jobs', request.id)
    return carried(ok({ id: request.id }))
  })
}

const IMPLEMENTED: Record<string, Async> = {
  listProjects: listProjects as Async,
  getPaperOutline: getPaperOutline as Async,
  getCompileStatus: getCompileStatus as Async,
  checkZotero: checkZotero as Async,
  listZoteroCollections: listZoteroCollections as Async,
  searchZotero: searchZotero as Async,
  importZoteroItem: importZoteroItem as Async,
  exportZoteroCollectionToBib: exportZoteroCollectionToBib as Async,
  getWorktree: getWorktree as Async,
  readArtifact: readArtifact as Async,
  listMeetingDecks: listMeetingDecks as Async,
  generateMeetingDeck: generateMeetingDeck as Async,
  deleteMeetingDeck: deleteMeetingDeck as Async,
  listEvents: listEvents as Async,
  generateProgressReport: generateProgressReport as Async,
  generateBrief: generateBrief as Async,
  pinMoment: pinMoment as Async,
  setEureka: setEureka as Async,
  getEurekaView: getEurekaView as Async,
  listVenueTemplates: listVenueTemplates as Async,
  applyVenueTemplate: applyVenueTemplate as Async,
  clearVenueTemplate: clearVenueTemplate as Async,
  exportWiki: exportWiki as Async,
  importWiki: importWiki as Async,
  setMainline: setMainline as Async,
  setIdeaParent: setIdeaParent as Async,
  adoptIdea: adoptIdea as Async,
  closeIdea: closeIdea as Async,
  renameFigure: renameFigure as Async,
  deleteFigure: deleteFigure as Async,
  updateFigure: updateFigure as Async,
  saveFigure: saveFigure as Async,
  convertFigure: convertFigure as Async,
  reorderPaperSections: reorderPaperSections as Async,
  reorderPaperSubsections: reorderPaperSubsections as Async,
  setVenueWatch: setVenueWatch as Async,
  saveExperiment: saveExperiment as Async,
  updateExperiment: updateExperiment as Async,
  deleteExperiment: deleteExperiment as Async,
  getForaging: getForaging as Async,
  getMomentIndex: getMomentIndex as Async,
  getEvidenceGraph: getEvidenceGraph as Async,
  generateDigest: generateDigest as Async,
  getPaperSource: getPaperSource as Async,
  getBibliography: getBibliography as Async,
  listPaperSnapshots: listPaperSnapshots as Async,
  getPaperSnapshot: getPaperSnapshot as Async,
  revertPaperSnapshot: revertPaperSnapshot as Async,
  saveBibliography: saveBibliography as Async,
  importPapersToBib: importPapersToBib as Async,
  savePaperSource: saveSource as Async,
  compile: compile as Async,
  createProject: createProject as Async,
  renameProject: renameProject as Async,
  deleteProject: deleteProject as Async,
  listPapers: listPapers as Async,
  listExperiments: listExperiments as Async,
  listFigures: listFigures as Async,
  listServers: listServers as Async,
  listVenueDeadlines: listVenueDeadlines as Async,
  refreshVenueDeadlines: refreshVenueDeadlines as Async,
  listJobs: listJobs as Async,
  listBackups: listBackups as Async,
  getTaskHealth: getTaskHealth as Async,
  listArxivSubscriptions: listArxivSubscriptions as Async,
  saveArxivSubscription: saveArxivSubscription as Async,
  deleteArxivSubscription: deleteArxivSubscription as Async,
  checkArxivSubscriptions: checkArxivSubscriptions as Async,
  searchArxiv: searchArxiv as Async,
  searchWeb: searchWeb as Async,
  addJournalEntry: addJournalEntry as Async,
  addEvidenceEdge: addEvidenceEdge as Async,
  retractEvidenceEdge: retractEvidenceEdge as Async,
  fetchPaperPdf: fetchPaperPdf as Async,
  importProject: importProject as Async,
  getImageGenConfig: getImageGenConfig as Async,
  setImageGenConfig: setImageGenConfig as Async,
  getSxngConfig: getSxngConfig as Async,
  setSxngConfig: setSxngConfig as Async,
  importPaper: importPaper as Async,
  removePaper: removePaper as Async,
  updatePaper: updatePaper as Async,
  saveServer: saveServer as Async,
  deleteServer: deleteServer as Async,
  checkServer: checkServer as Async,
  submitJob: submitJob as Async,
  deleteJob: deleteJob as Async,
}

/** ekko 侧还没实现的方法：回一个传输层失败，面板显示它自己的错误态。 */
function notImplemented(name: string): Promise<unknown> {
  return Promise.resolve(failed('not-implemented', `ekko 适配层还没接 ${name}`))
}

/**
 * 造一个与上游 `research` Remote 同形的方法表。包装成 Proxy 是因为方法有 80+ 个，
 * 逐个写签名没有收益：没实现的一律落到 `notImplemented`，实现一个就多一条映射。
 */
export function createMimirRemote(): Record<string, Async> {
  const target = {} as Record<string, Async>
  return new Proxy(target, {
    get: (_target, name: string | symbol) => {
      if (typeof name !== 'string') return undefined
      return IMPLEMENTED[name] ?? (() => notImplemented(name))
    },
  })
}
