/**
 * Research workbench state, modelled on Mimir's nine views.
 *
 * Mimir (1692775560/dsh-Mimir-Academic-research) treats a research project as
 * one aggregate root: papers / library / experiments / figures / decks /
 * servers / ledger / venues all hang off it, and the overview reads the
 * pipeline out of those same records.
 *
 * This port keeps that shape but stores state locally (localStorage, one bucket
 * per project) instead of a server-side wiki, and hands long-running work to
 * the agent through the draft channel the chat composer already understands.
 */

export interface ResearchProject {
  id: string
  name: string
  createdAt: number
}

export interface OutlineNode {
  id: string
  level: number
  title: string
}

export interface PaperSnapshot {
  id: string
  at: number
  label: string
}

export interface PaperRecord {
  id: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  score: number
  status: 'new' | 'reading' | 'read'
}

export interface ExperimentRecord {
  id: string
  config: string
  metrics: Array<{ name: string; value: string }>
  conclusion: string
  at: number
}

export interface FigureRecord {
  id: string
  name: string
  origin: string
  insertedInto: string
}

export interface ServerRecord {
  id: string
  host: string
  user: string
  status: 'unknown' | 'online' | 'offline'
  jobs: Array<{ id: string; name: string; state: string }>
}

export interface LedgerEntry {
  id: string
  at: number
  kind: 'idea' | 'decision' | 'result'
  text: string
}

export interface VenueRecord {
  id: string
  name: string
  ccf: 'A' | 'B' | 'C'
  deadline: string
  starred: boolean
}

/** Everything that belongs to a single project. */
export interface ProjectData {
  subscriptions: string[]
  outline: OutlineNode[]
  source: string
  snapshots: PaperSnapshot[]
  papers: PaperRecord[]
  experiments: ExperimentRecord[]
  figures: FigureRecord[]
  servers: ServerRecord[]
  ledger: LedgerEntry[]
  venues: VenueRecord[]
}

export interface ResearchState {
  projects: ResearchProject[]
  activeProjectId: string
  byProject: Record<string, ProjectData>
}

export const RESEARCH_STATE_KEY = 'ekko.research.workspace.v1'

export const RESEARCH_VIEWS = [
  { id: 'overview', label: '总览' },
  { id: 'paper', label: '论文' },
  { id: 'library', label: '文献' },
  { id: 'experiments', label: '实验' },
  { id: 'figures', label: '图表' },
  { id: 'decks', label: '组会' },
  { id: 'servers', label: '服务器' },
  { id: 'ledger', label: '记录' },
  { id: 'venues', label: '会议' },
] as const

export type ResearchViewId = typeof RESEARCH_VIEWS[number]['id']

/** The six lenses Mimir uses to summarise a project; rendered as chips here. */
export const LEDGER_LENSES = [
  { id: 'progress', label: '进展' },
  { id: 'blockers', label: '卡点' },
  { id: 'decisions', label: '决策' },
  { id: 'next', label: '下一步' },
  { id: 'risks', label: '风险' },
  { id: 'asks', label: '待协助' },
] as const

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createProjectData(): ProjectData {
  return {
    subscriptions: [],
    outline: [],
    source: [
      '% main.tex',
      '\\documentclass[11pt]{article}',
      '\\title{Untitled}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{Introduction}',
      '',
      '\\end{document}',
    ].join('\n'),
    snapshots: [],
    papers: [],
    experiments: [],
    figures: [],
    servers: [],
    ledger: [],
    venues: [
      { id: uid('v'), name: 'NeurIPS', ccf: 'A', deadline: '2026-05-15', starred: true },
      { id: uid('v'), name: 'ICML', ccf: 'A', deadline: '2027-01-22', starred: false },
      { id: uid('v'), name: 'ACL', ccf: 'A', deadline: '2027-02-15', starred: false },
    ],
  }
}

export function createDefaultState(): ResearchState {
  const project: ResearchProject = {
    id: uid('proj'),
    name: '未命名项目',
    createdAt: Date.now(),
  }
  return {
    projects: [project],
    activeProjectId: project.id,
    byProject: { [project.id]: createProjectData() },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readResearchState(): ResearchState {
  const fallback = createDefaultState()
  try {
    const raw = localStorage.getItem(RESEARCH_STATE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return fallback
    const projects = parsed.projects
    const rawByProject = parsed.byProject
    if (!Array.isArray(projects) || projects.length === 0 || !isRecord(rawByProject)) return fallback
    const byProject = rawByProject as Record<string, ProjectData>
    const state = parsed as unknown as ResearchState
    const activeId = state.activeProjectId && byProject[state.activeProjectId]
      ? state.activeProjectId
      : (projects[0] as ResearchProject).id
    for (const project of projects) {
      if (!byProject[project.id]) byProject[project.id] = createProjectData()
    }
    return { projects, activeProjectId: activeId, byProject }
  } catch {
    return fallback
  }
}

export function writeResearchState(state: ResearchState): void {
  try {
    localStorage.setItem(RESEARCH_STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage full or blocked: the workbench still works for this session.
  }
}

/** Parse `\section{}` / `\subsection{}` into an outline. */
export function outlineFromSource(source: string): OutlineNode[] {
  const nodes: OutlineNode[] = []
  const re = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const level = match[1] === 'section' ? 1 : match[1] === 'subsection' ? 2 : 3
    nodes.push({ id: uid('h'), level, title: match[2].trim() })
  }
  return nodes
}

/** Days until a YYYY-MM-DD deadline (negative when past). */
export function daysUntil(date: string): number {
  const target = new Date(`${date}T23:59:59`).getTime()
  if (Number.isNaN(target)) return 0
  return Math.ceil((target - Date.now()) / 86400000)
}

/** Pipeline stages Mimir's overview reads out of the same records. */
export function pipelineStats(data: ProjectData) {
  return [
    { id: 'library', label: '文献', value: data.papers.length, hint: `${data.subscriptions.length} 个订阅` },
    { id: 'experiments', label: '实验', value: data.experiments.length, hint: `${data.experiments.reduce((n, e) => n + e.metrics.length, 0)} 个指标` },
    { id: 'figures', label: '图表', value: data.figures.length, hint: `${data.figures.filter(f => f.insertedInto).length} 张已入稿` },
    { id: 'paper', label: '论文', value: data.snapshots.length, hint: data.source.includes('\\begin{document}') ? '源码就绪' : '待初始化' },
  ]
}
