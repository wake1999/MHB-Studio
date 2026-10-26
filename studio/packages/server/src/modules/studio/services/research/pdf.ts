/**
 * Download one paper's PDF into its project directory.
 *
 * The panel's "抓取 PDF" action needs the bytes on the same disk as `main.tex`,
 * so the paper can be cited and read offline; nothing is cached outside the
 * project. Only arXiv is supported (that is what the papers table is keyed by);
 * a machine without outbound access fails with the reason instead of writing a
 * zero-byte file.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { projectDir } from './paper'
import { readStore, researchRoot, updateStore, type ResearchPaper } from './store'

/**
 * One download's timeout. 2.2MB over a thin pipe measured ~60s on the deploy
 * host, so a 60s budget failed at the line; arXiv's own API host is used
 * (`export.arxiv.org`, connect measured 12x faster than `arxiv.org`).
 */
const FETCH_TIMEOUT_MS = 180_000
/** arXiv's API host; byte-identical PDFs, much shorter connect time. */
const PDF_HOST = 'https://export.arxiv.org'
/** Refuse anything larger: a paper PDF is well under this. */
const MAX_PDF_BYTES = 80 * 1024 * 1024
/** arXiv ids: `2401.01234`, `2401.01234v2`, `hep-th/9901001`. */
const ARXIV_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}(\/[0-9]{7})?$/

/** `hep-th/9901001` → `hep-th_9901001`: one flat, safe file name. */
function fileNameOf(arxivId: string): string {
  return `${arxivId.replace(/[/\\]/g, '_')}.pdf`
}

/**
 * Fetch `https://arxiv.org/pdf/<id>` and record the local path on the paper.
 * @param profile - research profile.
 * @param projectId - the project the paper belongs to.
 * @param arxivId - the paper's arXiv id (or its store row id).
 * @returns the stored row, now carrying `pdfPath`.
 */
export async function fetchPaperPdf(
  profile: string | undefined,
  projectId: string,
  arxivId: string,
): Promise<ResearchPaper> {
  const id = arxivId.trim()
  if (id === '') throw new Error('arxiv_id_empty')
  if (!ARXIV_ID.test(id)) throw new Error('arxiv_id_invalid')

  const store = await readStore(profile)
  const paper = store.papers.find(row => row.projectId === projectId
    && (row.arxivId === id || row.id === id))
  if (paper === undefined) throw new Error('paper_not_found')

  const dir = path.join(projectDir(projectId, profile), 'references')
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, fileNameOf(paper.arxivId || id))

  let response: Response
  try {
    response = await fetch(`${PDF_HOST}/pdf/${paper.arxivId || id}`, {
      headers: { 'User-Agent': 'ekko-research/1.0 (panel fetch)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`arxiv_unreachable: ${reason}`)
  }
  if (!response.ok) throw new Error(`arxiv_http_${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('arxiv_empty_body')
  if (bytes.length > MAX_PDF_BYTES) throw new Error('arxiv_too_large')
  // arXiv answers 200 with an HTML "not found" page for some bad ids.
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('arxiv_not_pdf')

  await fs.writeFile(target, bytes)

  const updated = await updateStore(profile, 'papers.pdf-fetched', draft => {
    const row = draft.papers.find(item => item.id === paper.id)
    if (row === undefined) return null
    row.pdfPath = target
    return row
  })
  if (updated === null) throw new Error('paper_not_found')
  return updated
}

/** One paper's fetched PDF, as bytes: the panel's reader wants no host path. */
export interface PaperPdfFile {
  bytes: Buffer
  file: string
}

/**
 * Read one paper's fetched PDF. The row is looked up by arXiv id (or row id)
 * across the profile, because the panel knows the paper, not which project it
 * was fetched under. The stored path must stay inside the research root: it is
 * a host path written by an earlier fetch, so it is not trusted blindly.
 * @param profile - research profile.
 * @param arxivIdOrId - the paper's arXiv id or its store row id.
 * @returns the bytes plus the file name, for the reader's download header.
 */
export async function readPaperPdfFile(
  profile: string | undefined,
  arxivIdOrId: string,
): Promise<PaperPdfFile> {
  const key = arxivIdOrId.trim()
  if (key === '') throw new Error('arxiv_id_empty')

  const store = await readStore(profile)
  const matches = store.papers.filter(row => row.arxivId === key || row.id === key)
  if (matches.length === 0) throw new Error('paper_not_found')
  // Prefer a row that actually links a file: the same arXiv id can sit in
  // several projects, and only one of them need have fetched the PDF.
  const paper = matches.find(row => (row.pdfPath ?? '').trim() !== '')
  if (paper === undefined) throw new Error('pdf_not_found')

  const stored = (paper.pdfPath ?? '').trim()
  const root = path.resolve(researchRoot(profile))
  const target = path.resolve(stored)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('pdf_path_invalid')

  const bytes = await fs.readFile(target)
  return { bytes, file: path.basename(target) }
}
