/**
 * The two ledger writes the panel performs by hand: a journal line and a
 * declared evidence edge.
 *
 * ekko has no append-only ledger table, so both land in the research store as
 * ordinary rows (`journal`, `evidence`). The panel only ever sees the shapes it
 * expects: a journal write comes back as one `EventRecord`, an edge write as
 * its `dedupKey` identity. Retraction is a flag on the row — declarations and
 * retractions stay in the store side by side, like the append-only original.
 */
import { createHash } from 'node:crypto'

import { newId, readStore, updateStore } from './store'

/** One `EventRecord` as the panel's ledger views read it. */
export interface LedgerEventView {
  id: string
  ts: string
  actor: { kind: 'user' | 'agent' | 'subagent' | 'module' | 'system'; id: string }
  action: string
  refs: Record<string, string>
  payload: Record<string, unknown>
}

/** Upper bounds: a journal line is a line, not a chapter. */
const MAX_TEXT = 4_000
const MAX_NOTE = 500

function iso(ms: number): string {
  return new Date(ms || Date.now()).toISOString()
}

function clampAffect(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(-2, Math.min(2, value))
}

export interface JournalRequest {
  text: string
  projectId?: string
  ideaId?: string
  valence?: number
  arousal?: number
  question?: { kind: string; lineId: string }
}

/**
 * Append one journal line to the addressed project and return it as a ledger
 * event (`journal.entry.added`) so the panel's event list can show it.
 */
export async function addJournalEntry(
  profile: string | undefined,
  request: JournalRequest,
): Promise<{ event: LedgerEventView }> {
  const text = request.text.trim()
  if (text === '') throw new Error('journal_text_empty')
  if (text.length > MAX_TEXT) throw new Error('journal_text_too_long')

  const at = Date.now()
  const entry = await updateStore(profile, 'journal.entry.added', store => {
    const projectId = (request.projectId ?? '').trim()
    if (projectId !== '' && !store.projects.some(project => project.id === projectId)) return null
    const row = {
      id: newId('journal'),
      projectId,
      ideaId: (request.ideaId ?? '').trim(),
      text,
      valence: clampAffect(request.valence),
      arousal: clampAffect(request.arousal),
      questionKind: request.question?.kind ?? '',
      questionLineId: request.question?.lineId ?? '',
      at,
    }
    store.journal.unshift(row)
    return row
  })
  if (entry === null) throw new Error('project_not_found')

  const refs: Record<string, string> = {}
  if (entry.projectId !== '') refs.projectId = entry.projectId
  if (entry.ideaId !== '') refs.ideaId = entry.ideaId
  const payload: Record<string, unknown> = {
    text: entry.text,
    valence: entry.valence,
    arousal: entry.arousal,
  }
  if (entry.questionKind !== '') {
    payload.question = { kind: entry.questionKind, lineId: entry.questionLineId }
  }
  return {
    event: {
      id: `ev-${entry.id}`,
      ts: iso(entry.at),
      actor: { kind: 'user', id: 'panel' },
      action: 'journal.entry.added',
      refs,
      payload,
    },
  }
}

/** The relations a declared edge may carry (the upstream enum). */
const EDGE_RELS = new Set([
  'supports', 'contradicts', 'tests', 'cites', 'extends', 'uses', 'retrieved-via',
])

/** `<rel>|<src>|<dst>` → a stable 16-hex identity. */
function dedupKeyOf(rel: string, src: string, dst: string): string {
  return createHash('sha1').update(`${rel}|${src}|${dst}`).digest('hex').slice(0, 16)
}

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

/**
 * Declare one evidence edge. Declaration is idempotent: repeating the same
 * `(rel, src, dst)` returns the existing `dedupKey` instead of stacking rows.
 */
export async function addEvidenceEdge(
  profile: string | undefined,
  request: EvidenceEdgeRequest,
): Promise<{ dedupKey: string; rel: string; src: string; dst: string }> {
  const rel = request.rel.trim()
  const src = request.src.trim()
  const dst = request.dst.trim()
  if (!EDGE_RELS.has(rel)) throw new Error('edge_bad_rel')
  if (src === '' || dst === '') throw new Error('edge_bad_endpoints')
  if (src.length > 128 || dst.length > 128) throw new Error('edge_key_too_long')
  const dedupKey = dedupKeyOf(rel, src, dst)

  await updateStore(profile, 'evidence.edge.added', store => {
    const existing = store.evidence.find(row => row.dedupKey === dedupKey && row.retractedAt === undefined)
    if (existing !== undefined) return existing.id
    store.evidence.push({
      id: newId('edge'),
      projectId: (request.projectId ?? '').trim(),
      ideaId: (request.ideaId ?? '').trim(),
      claimId: (request.claimId ?? '').trim(),
      dedupKey,
      rel,
      src,
      dst,
      srcLabel: (request.srcLabel ?? '').trim(),
      dstLabel: (request.dstLabel ?? '').trim(),
      note: (request.note ?? '').trim().slice(0, MAX_NOTE),
      at: Date.now(),
    })
    return dedupKey
  }, { projectId: (request.projectId ?? '').trim() })
  return { dedupKey, rel, src, dst }
}

/**
 * Retract every active declaration of one `dedupKey` (dedupKey granularity,
 * like the append-only original). Unused scope refs are accepted and dropped.
 */
export async function retractEvidenceEdge(
  profile: string | undefined,
  request: { dedupKey: string; reason?: string },
): Promise<{ dedupKey: string }> {
  const dedupKey = request.dedupKey.trim()
  if (dedupKey === '') throw new Error('edge_dedup_key_empty')
  const reason = (request.reason ?? '').trim().slice(0, MAX_NOTE)
  const hit = await updateStore(profile, 'evidence.edge.retracted', store => {
    const rows = store.evidence.filter(row => row.dedupKey === dedupKey && row.retractedAt === undefined)
    if (rows.length === 0) return 0
    const at = Date.now()
    for (const row of rows) {
      row.retractedAt = at
      if (reason !== '') row.retractReason = reason
    }
    return rows.length
  })
  if (hit === 0) {
    const store = await readStore(profile)
    const known = store.evidence.some(row => row.dedupKey === dedupKey)
    throw new Error(known ? 'edge_already_retracted' : 'edge_not_found')
  }
  return { dedupKey }
}
