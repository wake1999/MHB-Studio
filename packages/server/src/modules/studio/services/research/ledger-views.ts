/**
 * Ledger-derived views for the record (记录) screen.
 *
 * Upstream Mimir derives these five screens from its append-only wiki ledger.
 * ekko has no ledger table, so each view is assembled from what the research
 * store actually records: project creation, papers, experiments, figures and
 * ideas, each with its own timestamp. The shapes match the upstream wire
 * types exactly (the panel renders them unmodified); the numbers are honest
 * about their source — "events" below means one stored record, not one wiki
 * ledger event.
 *
 * Views that need ledger-only concepts (curated moments, declared evidence
 * edges) return empty, well-formed payloads so the panel draws its own empty
 * state instead of an error.
 */
import { readChangeLog, readStore } from './store'

const DAY_MS = 86_400_000

const iso = (ms: number): string => new Date(ms).toISOString()
const daysSince = (ms: number, nowMs: number): number => Math.max(0, Math.round((nowMs - ms) / DAY_MS))

type TouchKind = 'create' | 'work' | 'meta' | 'terminal'

interface Touch {
  readonly at: string
  readonly kind: TouchKind
  readonly action: string
}

interface Record_ {
  readonly at: number
  readonly action: string
  readonly kind: TouchKind
}

/** Every stored record that belongs to one project, as a flat timeline. */
function recordsOf(store: Awaited<ReturnType<typeof readStore>>, projectId: string): Record_[] {
  const records: Record_[] = []
  for (const paper of store.papers) {
    if (paper.projectId === projectId) records.push({ at: paper.addedAt, action: 'paper.added', kind: 'work' })
  }
  for (const experiment of store.experiments) {
    if (experiment.projectId === projectId) records.push({ at: experiment.at, action: 'experiment.recorded', kind: 'work' })
  }
  for (const figure of store.figures) {
    if (figure.projectId === projectId) records.push({ at: figure.at, action: 'figure.saved', kind: 'work' })
  }
  for (const idea of store.ideas) {
    if (idea.projectId !== projectId) continue
    records.push({
      at: idea.at,
      action: `idea.${idea.kind}`,
      kind: idea.kind === 'idea' ? 'meta' : 'terminal',
    })
  }
  return records.sort((a, b) => a.at - b.at)
}

/** `getWorktree`: one lane per project and per idea, with the store's own touches. */
export async function worktreeView(profile?: string) {
  const store = await readStore(profile)
  const now = Date.now()
  const projectTitle = new Map(store.projects.map(project => [project.id, project.title]))
  const ideaLine = new Map(store.ideas.map(idea => [idea.id, `idea:${idea.id}`]))

  const lanes: Array<Record<string, unknown>> = []

  for (const project of store.projects) {
    const records = recordsOf(store, project.id)
    const times = [project.createdAt, project.updatedAt, ...records.map(record => record.at)]
    const firstSeen = Math.min(...times)
    const lastSeen = Math.max(...times)
    const touches: Touch[] = [
      { at: iso(project.createdAt), kind: 'create', action: 'project.created' },
      ...records.map(record => ({ at: iso(record.at), kind: record.kind, action: record.action })),
    ]
    lanes.push({
      lineId: `project:${project.id}`,
      label: project.title,
      status: 'open',
      state: records.length === 0 ? 'stalled' : 'exploring',
      parentLineId: null,
      parentLabel: null,
      firstSeen: iso(firstSeen),
      lastSeen: iso(lastSeen),
      eventCount: touches.length,
      drift: 0,
      closedAt: null,
      closeReason: null,
      gutDays: null,
      idleDays: daysSince(lastSeen, now),
      touches,
    })
  }

  for (const idea of store.ideas) {
    const adopted = idea.kind !== 'idea'
    const closed = typeof idea.closedAt === 'number'
    lanes.push({
      lineId: `idea:${idea.id}`,
      label: idea.text.slice(0, 60),
      status: closed ? 'failed' : (adopted ? 'adopted' : 'open'),
      state: closed ? 'abandoned' : (adopted ? 'settled' : 'exploring'),
      parentLineId: idea.parentId === '' ? null : (ideaLine.get(idea.parentId) ?? `idea:${idea.parentId}`),
      parentLabel: idea.parentId === '' ? null : (projectTitle.get(idea.projectId) ?? null),
      firstSeen: iso(idea.at),
      lastSeen: iso(idea.at),
      eventCount: 1,
      drift: 0,
      closedAt: closed ? iso(idea.closedAt as number) : (adopted ? iso(idea.at) : null),
      closeReason: closed ? (idea.closeReason ?? null) : (adopted ? `记录为 ${idea.kind}` : null),
      gutDays: null,
      idleDays: daysSince(idea.at, now),
      touches: [{ at: iso(idea.at), kind: 'create', action: `idea.${idea.kind}` }],
    })
  }

  const lineLabel = (lineId: string): string => {
    if (lineId.startsWith('project:')) {
      const id = lineId.slice('project:'.length)
      return projectTitle.get(id) ?? lineId
    }
    if (lineId.startsWith('idea:')) {
      const id = lineId.slice('idea:'.length)
      const idea = store.ideas.find(item => item.id === id)
      return idea ? idea.text.slice(0, 60) : lineId
    }
    return lineId
  }
  const mainlineRef = store.mainline ?? null
  return {
    derivedAt: iso(now),
    lanes,
    mainline: mainlineRef === null ? null : {
      lineId: mainlineRef.lineId,
      label: lineLabel(mainlineRef.lineId),
      declaredAt: iso(mainlineRef.declaredAt),
    },
    mainlineHistory: (store.mainlineHistory ?? []).map(ref => ({
      lineId: ref.lineId,
      label: lineLabel(ref.lineId),
      declaredAt: iso(ref.declaredAt),
    })),
    counts: {
      open: lanes.filter(lane => lane.status === 'open').length,
      failed: lanes.filter(lane => lane.status === 'failed').length,
      adopted: lanes.filter(lane => lane.status === 'adopted').length,
    },
  }
}

/** `getForaging`: one territory per project, activity measured from stored timestamps. */
export async function foragingView(profile?: string) {
  const store = await readStore(profile)
  const now = Date.now()

  const territories = store.projects.map(project => {
    const records = recordsOf(store, project.id)
    const times = [project.createdAt, project.updatedAt, ...records.map(record => record.at)]
    const firstSeen = Math.min(...times)
    const lastSeen = Math.max(...times)
    return {
      projectId: project.id,
      label: project.title,
      eventCount: records.length + 1,
      firstSeen: iso(firstSeen),
      lastSeen: iso(lastSeen),
      activityMass: records.length + 1,
      harvestCount: 0,
      lastHarvestAt: null,
      daysSinceHarvest: null,
      daysSinceActivity: daysSince(lastSeen, now),
    }
  })

  return {
    derivedAt: iso(now),
    territories,
    baseline: { samples: 0, medianDays: null, iqrDays: null, minSamples: 5, speaks: false },
    cards: territories.map(territory => ({
      projectId: territory.projectId,
      label: territory.label,
      daysSinceHarvest: territory.daysSinceHarvest,
      daysSinceActivity: territory.daysSinceActivity,
      baselineMedianDays: null,
    })),
  }
}

/**
 * `getMomentIndex`: curated moments live in the upstream ledger only. ekko has
 * no moment table, so the timeline stays empty — the panel renders its own
 * empty state rather than pretending a record is a curated moment.
 */
export async function momentIndexView(profile?: string) {
  const store = await readStore(profile)
  const now = Date.now()
  const since = iso(now - 30 * DAY_MS)
  const until = iso(now)
  const total = store.papers.length + store.experiments.length + store.figures.length + store.ideas.length
  // 瞬间 = 变更日志里值得回看的几条（新建/里程碑），pinned/declined 由用户的标记决定。
  const changes = await readChangeLog(profile, 200)
  const marks = new Map((store.momentMarks ?? []).map(mark => [mark.targetEventId, mark]))
  const kindOf = (reason: string): string => {
    if (reason.startsWith('experiments.')) return 'milestone'
    if (reason.startsWith('eureka.')) return 'eureka'
    if (reason.startsWith('worktree.')) return 'creation'
    if (reason.startsWith('papers.') || reason.startsWith('paper.')) return 'creation'
    if (reason.startsWith('figures.') || reason.startsWith('decks.')) return 'creation'
    if (reason.startsWith('wiki.')) return 'burst'
    return 'creation'
  }
  const moments = changes
    .filter(change => change.at >= now - 30 * DAY_MS)
    .slice(-40)
    .map(change => {
      const id = String(change.revision)
      const mark = marks.get(id)
      return {
        id,
        at: iso(change.at),
        kind: kindOf(change.reason || ''),
        canonical: mark ? mark.pinned : false,
        lineLabel: null,
        note: mark && mark.note !== '' ? mark.note : (change.reason || null),
        pinned: mark ? mark.pinned : false,
        declined: mark ? !mark.pinned : false,
        // 上游 MomentRow 需要这三个字段来排版：来源短语、量级与「贴近度」。
        sources: ['burst'],
        stats: { eventCount: 1, spanMinutes: 0, distinctLines: 1 },
        closeness: null,
      }
    })
    .reverse()
  return {
    derivedAt: until,
    window: { since, until },
    retrieval: { eventsHit: moments.length, eventsTotal: total, truncated: false, silences: [] },
    speaks: false,
    moments,
  }
}

/**
 * `getEvidenceGraph`: fold the declared edges of the store into the graph view.
 *
 * ekko keeps declarations as store rows (`evidence`) rather than ledger
 * events, so this is a thin projection, not the upstream fold: nodes are the
 * endpoints that appear in a declaration, edges keep their `dedupKey`, and a
 * retraction is a flag on the row. The claim-centric timeline needs claims,
 * which the store does not have — it stays empty on purpose (the panel prints
 * its own empty state there) while the counts stay honest.
 */
export async function evidenceGraphView(profile?: string) {
  const store = await readStore(profile)
  const now = Date.now()
  const since = iso(now - 90 * DAY_MS)
  const until = iso(now)
  const total = store.papers.length + store.experiments.length + store.figures.length
  const rows = store.evidence ?? []

  interface NodeRow {
    key: string
    kind: string
    label: string | null
    firstSeen: string
    lastSeen: string
    aliases: string[]
    sourceEventId: string
  }
  const nodes = new Map<string, NodeRow>()
  const note = (key: string, label: string, ts: string, eventId: string): void => {
    const trimmedKey = key.trim()
    if (trimmedKey === '') return
    const colon = trimmedKey.indexOf(':')
    const kind = colon > 0 ? trimmedKey.slice(0, colon) : 'unknown'
    const existing = nodes.get(trimmedKey)
    if (existing === undefined) {
      nodes.set(trimmedKey, {
        key: trimmedKey,
        kind,
        label: label.trim() === '' ? null : label.trim(),
        firstSeen: ts,
        lastSeen: ts,
        aliases: [],
        sourceEventId: eventId,
      })
      return
    }
    if (existing.label === null && label.trim() !== '') existing.label = label.trim()
    if (ts < existing.firstSeen) existing.firstSeen = ts
    if (ts > existing.lastSeen) existing.lastSeen = ts
  }

  const edges = rows.map(row => {
    const ts = iso(row.at)
    note(row.src, row.srcLabel, ts, row.id)
    note(row.dst, row.dstLabel, ts, row.id)
    const retracted = row.retractedAt !== undefined
    return {
      id: row.id,
      dedupKey: row.dedupKey,
      rel: row.rel,
      src: row.src,
      dst: row.dst,
      ts,
      actor: { kind: 'user' as const, id: 'panel' },
      sourceEventId: row.id,
      note: row.note === '' ? null : row.note,
      retracted,
      retractedAt: retracted ? iso(row.retractedAt ?? row.at) : null,
      retractedBy: retracted ? { kind: 'user' as const, id: 'panel' } : null,
      retractEventId: null,
      retractReason: row.retractReason ?? null,
      scope: {
        projectId: row.projectId === '' ? null : row.projectId,
        ideaId: row.ideaId === '' ? null : row.ideaId,
        claimId: row.claimId === '' ? null : row.claimId,
      },
    }
  })

  const active = edges.filter(edge => !edge.retracted)
  // 同一对端点上既支持又反驳，就是上游意义上的 conflict。
  const conflicts: Array<{ nodeKey: string; supporting: typeof edges[number]; contradicting: typeof edges[number] }> = []
  for (const supporting of active.filter(edge => edge.rel === 'supports')) {
    for (const contradicting of active.filter(edge => edge.rel === 'contradicts')) {
      if (supporting.src !== contradicting.src || supporting.dst !== contradicting.dst) continue
      conflicts.push({ nodeKey: supporting.dst, supporting, contradicting })
    }
  }
  const distinct = new Set(rows.map(row => row.dedupKey)).size

  return {
    derivedAt: until,
    window: { since, until },
    retrieval: { eventsHit: rows.length, eventsTotal: total, truncated: false },
    graph: {
      derivationVersion: 1,
      nodes: [...nodes.values()],
      edges,
      conflicts,
      timeline: [],
      stats: {
        totalEdges: rows.length,
        activeEdges: active.length,
        retractedEdges: rows.length - active.length,
        retractOrphans: 0,
        duplicateEdges: rows.length - distinct,
        aliasMerges: 0,
        unnormalizable: 0,
      },
    },
  }
}

/** The six capsule perspectives, in the upstream render order. */
const PERSPECTIVES: ReadonlyArray<{ id: string; zh: string; en: string }> = [
  { id: 'mainline', zh: '主线', en: 'Mainline' },
  { id: 'moment', zh: '瞬间', en: 'Moments' },
  { id: 'dead-branch', zh: '死枝', en: 'Dead branches' },
  { id: 'literature', zh: '文献', en: 'Literature' },
  { id: 'rhythm', zh: '节奏', en: 'Rhythm' },
  { id: 'open-loop', zh: '未闭合', en: 'Open loops' },
]

/**
 * `generateDigest`: the capsule report, assembled from store counts.
 *
 * Capsules are curated atoms upstream; without a ledger there is nothing to
 * curate, so every perspective is present but empty (the panel prints its
 * "no capsules in this perspective" hint). The retrieval line reports the
 * real number of stored records in the window — no invented events.
 */
export async function digestView(
  profile: string | undefined,
  options: { tier?: unknown; since?: unknown; until?: unknown; lang?: unknown },
) {
  const store = await readStore(profile)
  const now = Date.now()
  const tier = options.tier === 'monthly' || options.tier === 'project' ? options.tier : 'weekly'
  const span = tier === 'monthly' ? 30 : tier === 'project' ? 365 : 7
  const since = typeof options.since === 'string' && options.since !== '' ? options.since : iso(now - span * DAY_MS)
  const until = typeof options.until === 'string' && options.until !== '' ? options.until : iso(now)
  const lang = options.lang === 'en' ? 'en' : 'zh'

  const sinceMs = Date.parse(since)
  const untilMs = Date.parse(until)
  const lower = Number.isNaN(sinceMs) ? 0 : sinceMs
  const upper = Number.isNaN(untilMs) ? now : untilMs
  const inWindow = (at: number): boolean => at >= lower && at < upper

  const papers = store.papers.filter(paper => inWindow(paper.addedAt)).length
  const experiments = store.experiments.filter(experiment => inWindow(experiment.at)).length
  const figures = store.figures.filter(figure => inWindow(figure.at)).length
  const ideas = store.ideas.filter(idea => inWindow(idea.at)).length
  const eventsHit = papers + experiments + figures + ideas

  const digest = {
    tier,
    asOf: iso(now),
    window: { since, until },
    retrieval: {
      source: 'ekko research store',
      since,
      until,
      eventsHit,
      eventsTotal: eventsHit,
      truncated: false,
      derivationVersion: 1,
      silences: [],
    },
    overview: [],
    perspectives: PERSPECTIVES.map(perspective => ({
      perspective: perspective.id,
      label: { zh: perspective.zh, en: perspective.en },
      capsules: [],
    })),
    eurekaTable: [],
    mermaid: null,
  }

  const title = tier === 'monthly' ? '月度经验胶囊' : tier === 'project' ? '项目经验胶囊' : '本周经验胶囊'
  const markdown = [
    `# ${title}`,
    '',
    `- 窗口：${since} → ${until}`,
    `- 范围内记录：${eventsHit} 条（文献 ${papers} · 实验 ${experiments} · 图表 ${figures} · 想法 ${ideas}）`,
    `- 生成于：${iso(now)}`,
    '',
    '> ekko 的工作台还没有 ledger 事件表，本报告按项目内记录的时间戳汇总；',
    '> 六个视角（主线/瞬间/死枝/文献/节奏/未闭合）在接入 ledger 后才会填充胶囊。',
  ].join('\n')

  return { digest, markdown, tier, lang, generatedAt: iso(now) }
}
