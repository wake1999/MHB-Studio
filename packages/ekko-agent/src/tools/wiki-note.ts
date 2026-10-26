import type { AgentTool, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'

/** One write/read result, already shaped for JSON transport. */
export type WikiNotePayload = Record<string, unknown>

/**
 * The research store lives in the server, so the server installs this handler
 * (it may also be absent: Codex/Claude runtimes do not have the wiki).
 */
export type WikiNoteHandler = (
  input: Record<string, unknown>,
  context: AgentToolContext,
) => Promise<WikiNotePayload>

let wikiNoteHandler: WikiNoteHandler | null = null

/** Installed once at bootstrap; `null` removes the tool from every runtime. */
export function configureWikiNoteHandler(next: WikiNoteHandler | null): void {
  wikiNoteHandler = next
}

export class WikiNoteTool implements AgentTool {
  readonly definition = {
    name: 'wiki_note',
    description: [
      'Read and write the research wiki of this workspace: projects, papers, idea lanes, experiments, journal lines and evidence edges.',
      'This is the workbench panel data, not a file: writes appear in the panel and in its change log immediately.',
      'Call "list" first to learn ids; every write needs a project_id. Paper ids look like "paper_...", arXiv ids like "1706.03762".',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'get',
            'add_paper',
            'set_paper',
            'add_idea',
            'close_idea',
            'add_experiment',
            'set_experiment',
            'add_journal',
            'add_evidence',
          ],
          description: 'Operation to run.',

        },
        project_id: { type: 'string', description: 'Project id (proj_...). Required for writes and for project-scoped reads.' },
        collection: {
          type: 'string',
          enum: ['projects', 'papers', 'ideas', 'experiments', 'journal', 'evidence', 'figures'],
          description: 'list/get only: which collection to read.',
        },
        id: { type: 'string', description: 'list/get only: record id (or arXiv id for papers).' },

        paper_id: { type: 'string', description: 'set_paper: paper id.' },
        arxiv_id: { type: 'string', description: 'set_paper: arXiv id, used when paper_id is unknown.' },
        idea_id: { type: 'string', description: 'close_idea / add_journal / add_evidence: owning idea lane id.' },
        experiment_id: { type: 'string', description: 'set_experiment: experiment id.' },

        title: { type: 'string', description: 'add_paper / set_project: title.' },
        authors: { type: 'string', description: 'add_paper: author list, "A, B and C".' },
        year: { type: 'string', description: 'add_paper / set_paper: year.' },
        venue: { type: 'string', description: 'add_paper / set_paper: venue or preprint server.' },
        doi: { type: 'string', description: 'add_paper: DOI.' },
        url: { type: 'string', description: 'add_paper: link.' },
        notes: { type: 'string', description: 'add_paper / set_paper: reading notes (markdown).' },
        tags: {
          type: 'array',
          description: 'set_paper: replace the paper labels (venue/year chips are derived only when tags are absent).',
          items: { type: 'string' },
        },
        status: {
          type: 'string',
          description: 'papers: new | reading | read. experiments: planned | running | done | failed.',
        },
        score: { type: 'number', description: 'set_paper: 0-10 relevance score for the selected project.' },

        text: { type: 'string', description: 'add_idea / add_journal: the line to record.' },
        kind: { type: 'string', enum: ['idea', 'decision', 'result'], description: 'add_idea: lane kind. Defaults to idea.' },
        parent_id: { type: 'string', description: 'add_idea: parent lane id, empty for a root lane.' },
        reason: { type: 'string', description: 'close_idea: why this lane is closed.' },

        name: { type: 'string', description: 'add_experiment: experiment name.' },
        config: { type: 'string', description: 'add_experiment: configuration summary.' },
        metrics: {
          type: 'array',
          description: 'add_experiment / set_experiment: measured metrics.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              unit: { type: 'string' },
              better: { type: 'string', enum: ['max', 'min'] },
            },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
        conclusion: { type: 'string', description: 'add_experiment / set_experiment: conclusion.' },

        valence: { type: 'number', description: 'add_journal: -2..2, 0 when not filled.' },
        arousal: { type: 'number', description: 'add_journal: -2..2, 0 when not filled.' },
        question_kind: { type: 'string', description: 'add_journal: boundary question this line answers, empty when none.' },

        rel: { type: 'string', description: 'add_evidence: relation, e.g. supports | contradicts.' },
        src: { type: 'string', description: 'add_evidence: source node id.' },
        dst: { type: 'string', description: 'add_evidence: target node id.' },
        src_label: { type: 'string', description: 'add_evidence: human label for src.' },
        dst_label: { type: 'string', description: 'add_evidence: human label for dst.' },
        note: { type: 'string', description: 'add_evidence: why the edge holds.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }

  async execute(input: Record<string, unknown>, context: AgentToolContext = {}): Promise<AgentToolResult> {
    if (wikiNoteHandler === null) {
      return { ok: false, content: 'wiki_note is unavailable: this runtime has no research wiki attached.', error: 'unavailable' }
    }
    try {
      const payload = await wikiNoteHandler(input, context)
      return { ok: true, content: JSON.stringify(payload), data: payload }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, error: message }
    }
  }
}

/** Late-bound provider: the server installs the handler before the first run. */
export function createWikiNoteToolProvider(): AgentToolProvider {
  return {
    id: 'wiki-note',
    async listTools(): Promise<AgentTool[]> {
      return wikiNoteHandler === null ? [] : [new WikiNoteTool()]
    },
  }
}
