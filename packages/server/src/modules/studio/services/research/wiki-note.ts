import { configureWikiNoteHandler, type WikiNotePayload } from '../../../../../../ekko-agent/src/tools/wiki-note'
import {
  newId,
  readStore,
  updateStore,
  type ResearchEvidenceEdge,
  type ResearchExperiment,
  type ResearchIdea,
  type ResearchJournalEntry,
  type ResearchMetric,
  type ResearchPaper,
  type ResearchStore,
} from './store'

const PAPER_STATUS = new Set(['new', 'reading', 'read'])
const EXPERIMENT_STATUS = new Set(['planned', 'running', 'done', 'failed'])
const IDEA_KINDS = new Set(['idea', 'decision', 'result'])

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value.trim() : ''
}

function requiredText(input: Record<string, unknown>, key: string): string {
  const value = text(input, key)
  if (value === '') throw new Error(`wiki_note: "${key}" is required for this action.`)
  return value
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    throw new Error(`wiki_note: "${key}" must be a number.`)
  }
  return undefined
}

function metricsOf(input: Record<string, unknown>): ResearchMetric[] | undefined {
  const value = input.metrics
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('wiki_note: "metrics" must be an array.')
  return value.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>
    const name = text(record, 'name')
    if (name === '') throw new Error('wiki_note: every metric needs a "name".')
    const better = text(record, 'better')
    return {
      name,
      value: text(record, 'value'),
      unit: text(record, 'unit'),
      better: better === 'min' ? 'min' : 'max',
    } satisfies ResearchMetric
  })
}

function requireProject(store: ResearchStore, projectId: string): void {
  if (projectId === '') throw new Error('wiki_note: "project_id" is required; call list with collection "projects" to get one.')
  if (!store.projects.some((project) => project.id === projectId)) {
    throw new Error(`wiki_note: unknown project ${projectId}.`)
  }
}

function findPaper(store: ResearchStore, input: Record<string, unknown>): ResearchPaper {
  const paperId = text(input, 'paper_id')
  const arxivId = text(input, 'arxiv_id')
  if (paperId === '' && arxivId === '') throw new Error('wiki_note: set_paper needs "paper_id" or "arxiv_id".')
  const paper = paperId !== ''
    ? store.papers.find((item) => item.id === paperId)
    : store.papers.find((item) => item.arxivId === arxivId)
  if (paper === undefined) throw new Error(`wiki_note: no paper matches ${paperId || arxivId}.`)
  return paper
}

/** Compact rows for `list`; full records stay behind `get`. */
function summarize(store: ResearchStore, collection: string, projectId: string): unknown[] {
  const inProject = <T extends { projectId: string }>(rows: T[]): T[] =>
    projectId === '' ? rows : rows.filter((row) => row.projectId === projectId)
  switch (collection) {
    case 'projects':
      return store.projects.map((project) => ({ id: project.id, title: project.title }))
    case 'papers':
      return inProject(store.papers).slice(0, 40).map((paper) => ({
        id: paper.id,
        arxivId: paper.arxivId,
        title: paper.title,
        year: paper.year,
        status: paper.status,
        projectId: paper.projectId,
        hasNotes: paper.notes !== '',
      }))
    case 'ideas':
      return inProject(store.ideas).slice(-40).map((idea) => ({
        id: idea.id,
        kind: idea.kind,
        text: idea.text.slice(0, 120),
        parentId: idea.parentId,
        closed: idea.closedAt !== undefined,
      }))
    case 'experiments':
      return inProject(store.experiments).slice(-40).map((experiment) => ({
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
        projectId: experiment.projectId,
      }))
    case 'journal':
      return inProject(store.journal).slice(-40).map((entry) => ({
        id: entry.id,
        text: entry.text.slice(0, 120),
        ideaId: entry.ideaId,
      }))
    case 'evidence':
      return inProject(store.evidence).slice(-40).map((edge) => ({
        id: edge.id,
        rel: edge.rel,
        src: edge.src,
        dst: edge.dst,
        note: edge.note.slice(0, 80),
        retracted: edge.retractedAt !== undefined,
      }))
    case 'figures':
      return inProject(store.figures).slice(0, 40).map((figure) => ({
        id: figure.id,
        name: figure.name,
        projectId: figure.projectId,
      }))
    default:
      throw new Error(`wiki_note: unknown collection "${collection}".`)
  }
}

function pickById(store: ResearchStore, collection: string, id: string): unknown {
  const rows: Record<string, unknown[]> = {
    projects: store.projects,
    papers: store.papers,
    ideas: store.ideas,
    experiments: store.experiments,
    journal: store.journal,
    evidence: store.evidence,
    figures: store.figures,
  }
  const list = rows[collection]
  if (list === undefined) throw new Error(`wiki_note: unknown collection "${collection}".`)
  const match = list.find((row) => (row as { id?: string }).id === id
    || (collection === 'papers' && (row as { arxivId?: string }).arxivId === id))
  if (match === undefined) throw new Error(`wiki_note: no ${collection} record with id ${id}.`)
  return match
}

/**
 * `wiki_note` is the write-back channel the panel's research store was missing:
 * the dsh build exposes it as an MCP tool, and agent runtimes here have no such
 * tool, so every "record this in the wiki" instruction used to dead-end.
 */
export function installWikiNoteHandler(): void {
  configureWikiNoteHandler(async (input, context): Promise<WikiNotePayload> => {
    const rawProfile = typeof context.profileId === 'string' ? context.profileId.trim() : ''
    /* 'default' is the store's own fallback key; passing it through would resolve
       to <profiles>/default/.research and read an empty store instead of <home>/.research. */
    const profile = rawProfile === '' || rawProfile === 'default' ? undefined : rawProfile
    const action = requiredText(input, 'action')
    const projectId = text(input, 'project_id')

    if (action === 'list') {
      const store = await readStore(profile)
      const collection = text(input, 'collection')
      if (collection === '') {
        return {
          projects: store.projects.map((project) => ({
            id: project.id,
            title: project.title,
            papers: store.papers.filter((paper) => paper.projectId === project.id).length,
            ideas: store.ideas.filter((idea) => idea.projectId === project.id).length,
            experiments: store.experiments.filter((item) => item.projectId === project.id).length,
          })),
        }
      }
      return { collection, items: summarize(store, collection, projectId) }
    }

    if (action === 'get') {
      const store = await readStore(profile)
      return { record: pickById(store, requiredText(input, 'collection'), requiredText(input, 'id')) }
    }

    if (action === 'add_paper') {
      return updateStore(profile, 'wiki_note.add_paper', (store) => {
        requireProject(store, projectId)
        const arxivId = text(input, 'arxiv_id')
        const title = requiredText(input, 'title')
        if (arxivId !== '') {
          const existing = store.papers.find((paper) => paper.arxivId === arxivId)
          if (existing !== undefined) {
            throw new Error(`wiki_note: arXiv ${arxivId} is already ${existing.id}; use set_paper to update it.`)
          }
        }
        const paper: ResearchPaper = {
          id: newId('paper'),
          projectId,
          title,
          authors: text(input, 'authors'),
          year: text(input, 'year'),
          venue: text(input, 'venue'),
          doi: text(input, 'doi'),
          url: text(input, 'url'),
          arxivId,
          score: optionalNumber(input, 'score') ?? 0,
          status: 'new',
          notes: text(input, 'notes'),
          tags: [],
          addedAt: Date.now(),
        }
        store.papers.push(paper)
        return { id: paper.id, action }
      })
    }

    if (action === 'set_paper') {
      return updateStore(profile, 'wiki_note.set_paper', (store) => {
        const paper = findPaper(store, input)
        const changed: string[] = []
        const notes = input.notes
        if (typeof notes === 'string') { paper.notes = notes; changed.push('notes') }
        const title = text(input, 'title')
        if (title !== '') { paper.title = title; changed.push('title') }
        const status = text(input, 'status')
        if (status !== '') {
          if (!PAPER_STATUS.has(status)) throw new Error('wiki_note: paper status must be new, reading or read.')
          paper.status = status as ResearchPaper['status']
          changed.push('status')
        }
        const score = optionalNumber(input, 'score')
        if (score !== undefined) { paper.score = score; changed.push('score') }
        const venue = text(input, 'venue')
        if (venue !== '') { paper.venue = venue; changed.push('venue') }
        const year = text(input, 'year')
        if (year !== '') { paper.year = year; changed.push('year') }
        const tags = input.tags
        if (Array.isArray(tags)) {
          paper.tags = tags.filter((tag): tag is string => typeof tag === 'string')
          changed.push('tags')
        }
        if (changed.length === 0) throw new Error('wiki_note: set_paper got nothing to change.')
        return { id: paper.id, changed }
      })
    }

    if (action === 'add_idea') {
      return updateStore(profile, 'wiki_note.add_idea', (store) => {
        requireProject(store, projectId)
        const kind = text(input, 'kind') || 'idea'
        if (!IDEA_KINDS.has(kind)) throw new Error('wiki_note: idea kind must be idea, decision or result.')
        const parentId = text(input, 'parent_id')
        if (parentId !== '' && !store.ideas.some((idea) => idea.id === parentId)) {
          throw new Error(`wiki_note: unknown parent idea ${parentId}.`)
        }
        const idea: ResearchIdea = {
          id: newId('idea'),
          projectId,
          kind: kind as ResearchIdea['kind'],
          text: requiredText(input, 'text'),
          at: Date.now(),
          parentId,
        }
        store.ideas.push(idea)
        return { id: idea.id, action }
      })
    }

    if (action === 'close_idea') {
      return updateStore(profile, 'wiki_note.close_idea', (store) => {
        const ideaId = requiredText(input, 'idea_id')
        const idea = store.ideas.find((item) => item.id === ideaId)
        if (idea === undefined) throw new Error(`wiki_note: no idea ${ideaId}.`)
        idea.closedAt = Date.now()
        idea.closeReason = text(input, 'reason')
        return { id: idea.id, closed: true }
      })
    }

    if (action === 'add_experiment') {
      return updateStore(profile, 'wiki_note.add_experiment', (store) => {
        requireProject(store, projectId)
        const status = text(input, 'status') || 'planned'
        if (!EXPERIMENT_STATUS.has(status)) throw new Error('wiki_note: experiment status must be planned, running, done or failed.')
        const experiment: ResearchExperiment = {
          id: newId('exp'),
          projectId,
          name: requiredText(input, 'name'),
          config: text(input, 'config'),
          metrics: metricsOf(input) ?? [],
          conclusion: text(input, 'conclusion'),
          status: status as ResearchExperiment['status'],
          at: Date.now(),
        }
        store.experiments.push(experiment)
        return { id: experiment.id, action }
      })
    }

    if (action === 'set_experiment') {
      return updateStore(profile, 'wiki_note.set_experiment', (store) => {
        const experimentId = requiredText(input, 'experiment_id')
        const experiment = store.experiments.find((item) => item.id === experimentId)
        if (experiment === undefined) throw new Error(`wiki_note: no experiment ${experimentId}.`)
        const changed: string[] = []
        const status = text(input, 'status')
        if (status !== '') {
          if (!EXPERIMENT_STATUS.has(status)) throw new Error('wiki_note: experiment status must be planned, running, done or failed.')
          experiment.status = status as ResearchExperiment['status']
          changed.push('status')
        }
        const conclusion = input.conclusion
        if (typeof conclusion === 'string') { experiment.conclusion = conclusion; changed.push('conclusion') }
        const metrics = metricsOf(input)
        if (metrics !== undefined) { experiment.metrics = metrics; changed.push('metrics') }
        if (changed.length === 0) throw new Error('wiki_note: set_experiment got nothing to change.')
        return { id: experiment.id, changed }
      })
    }

    if (action === 'add_journal') {
      return updateStore(profile, 'wiki_note.add_journal', (store) => {
        requireProject(store, projectId)
        const ideaId = text(input, 'idea_id')
        if (ideaId !== '' && !store.ideas.some((idea) => idea.id === ideaId)) {
          throw new Error(`wiki_note: unknown idea ${ideaId}.`)
        }
        const entry: ResearchJournalEntry = {
          id: newId('journal'),
          projectId,
          ideaId,
          text: requiredText(input, 'text'),
          valence: optionalNumber(input, 'valence') ?? 0,
          arousal: optionalNumber(input, 'arousal') ?? 0,
          questionKind: text(input, 'question_kind'),
          questionLineId: '',
          at: Date.now(),
        }
        store.journal.push(entry)
        return { id: entry.id, action }
      })
    }

    if (action === 'add_evidence') {
      return updateStore(profile, 'wiki_note.add_evidence', (store) => {
        requireProject(store, projectId)
        const rel = requiredText(input, 'rel')
        const src = requiredText(input, 'src')
        const dst = requiredText(input, 'dst')
        const dedupKey = `${rel}|${src}|${dst}`
        const existing = store.evidence.find((edge) => edge.dedupKey === dedupKey && edge.retractedAt === undefined)
        if (existing !== undefined) return { id: existing.id, existing: true }
        const edge: ResearchEvidenceEdge = {
          id: newId('evidence'),
          projectId,
          ideaId: text(input, 'idea_id'),
          claimId: text(input, 'claim_id'),
          dedupKey,
          rel,
          src,
          dst,
          srcLabel: text(input, 'src_label'),
          dstLabel: text(input, 'dst_label'),
          note: text(input, 'note'),
          at: Date.now(),
        }
        store.evidence.push(edge)
        return { id: edge.id, action }
      })
    }

    throw new Error(`wiki_note: unknown action "${action}".`)
  })
}
