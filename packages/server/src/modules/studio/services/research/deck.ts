/**
 * Seminar deck scaffold.
 *
 * The host builds the structure from real records (papers, experiments, ledger)
 * and leaves the narrative slots empty on purpose: a generator that invents
 * findings would be worse than useless in a lab meeting. The agent fills the
 * script afterwards through the ordinary file tools.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { renderDeckPptx } from './deck-pptx'
import { newId, researchRoot, readStore, type ResearchDeck } from './store'

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/

function projectDir(projectId: string, profile?: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid_project_id')
  return path.join(researchRoot(profile), 'projects', projectId)
}

export interface DeckInput {
  title?: string
  progress?: string
  paperIds?: string[]
  audience?: string
}

function bullets(values: string[], empty: string): string {
  if (!values.length) return `- ${empty}`
  return values.map(value => `- ${value}`).join('\n')
}

export async function buildDeck(
  projectId: string,
  input: DeckInput,
  profile?: string,
): Promise<{ deck: ResearchDeck; path: string; markdown: string }> {
  // Check the id before touching the store so a traversal attempt is a 400,
  // not a misleading 404.
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid_project_id')
  const store = await readStore(profile)
  const project = store.projects.find(item => item.id === projectId)
  if (!project) throw new Error('project_not_found')

  const papers = store.papers.filter(item => item.projectId === projectId)
  const chosen = (input.paperIds && input.paperIds.length
    ? papers.filter(item => (input.paperIds as string[]).includes(item.id))
    : [...papers].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5))
  const experiments = store.experiments.filter(item => item.projectId === projectId)
  const ideas = store.ideas.filter(item => item.projectId === projectId)
  const figures = store.figures.filter(item => item.projectId === projectId)

  const title = (input.title || `${project.title} 组会汇报`).trim()
  const audience = (input.audience || '组会 20 分钟，导师与同方向同学').trim()
  const progress = (input.progress || '').trim() || '（补：本阶段做了什么、结果如何、卡在哪）'

  const slides: Array<{ heading: string; body: string }> = []
  slides.push({
    heading: `${title}`,
    body: bullets([
      `汇报人：待填`,
      `日期：${new Date().toISOString().slice(0, 10)}`,
      `听众：${audience}`,
      `文献 ${papers.length} 篇 / 实验 ${experiments.length} 条 / 图表 ${figures.length} 张`,
    ], '暂无统计'),
  })
  slides.push({
    heading: '一分钟速览',
    body: bullets([
      '一句话问题：待填',
      '一句话方法：待填',
      '一句话结果：待填（必须带数字）',
    ], '待填'),
  })
  slides.push({
    heading: '本次进展',
    body: progress.split('\n').map(line => `- ${line.replace(/^[-*]\s*/, '')}`).join('\n'),
  })

  for (const paper of chosen) {
    slides.push({
      heading: `${paper.title}（${paper.year || 'n.d.'}）`,
      body: bullets([
        `来源：${paper.venue || 'arXiv'}${paper.arxivId ? ` · arXiv:${paper.arxivId}` : ''}${paper.doi ? ` · DOI ${paper.doi}` : ''}`,
        `作者：${paper.authors || '待补'}`,
        '动机 / 方法 / 结论：待补（引用原文页码）',
        '可复用点：待补（数据、代码、评测协议或写作结构）',
        '与本题关系：待补（支撑 / 反驳 / 方法可借用）',
      ], '待补'),
      })
  }

  if (experiments.length) {
    slides.push({
      heading: '实验与指标',
      body: bullets(
        experiments.slice(0, 5).map(item => {
          const metrics = (item.metrics || [])
            .filter(metric => metric.value)
            .map(metric => `${metric.name}=${metric.value}${metric.unit || ''}（${metric.better === 'min' ? '越小越好' : '越大越好'}）`)
            .join('，')
          return `${item.name || '未命名实验'}：${metrics || '未记录指标'} · 状态 ${item.status}`
        }),
        '还没有实验记录',
      ),
    })
  }

  const decisions = ideas.filter(item => item.kind === 'decision').slice(0, 5)
  const results = ideas.filter(item => item.kind === 'result').slice(0, 5)
  slides.push({
    heading: '决策与结果',
    body: [
      '决策：',
      bullets(decisions.map(item => item.text), '待补'),
      '',
      '结果：',
      bullets(results.map(item => item.text), '待补'),
    ].join('\n'),
  })
  slides.push({
    heading: '卡点与风险',
    body: bullets([
      '卡点：待补（具体到文件 / 命令 / 数据）',
      '风险：待补（时间、算力、数据可得性）',
      '需要协助：待补（找谁、要什么）',
    ], '待补'),
  })
  slides.push({
    heading: '下一步',
    body: bullets([
      '本周：待补',
      '下周：待补',
      '里程碑：待补（可验证的产出）',
    ], '待补'),
  })
  slides.push({
    heading: '预期提问',
    body: bullets([
      '为什么不用基线 X？（准备一句话 + 一个数字）',
      '这个提升是否在噪声范围内？（准备方差与显著性的说法）',
      '数据规模再大 10 倍会怎样？（准备瓶颈分析）',
      '和最新工作 Y 的差别是什么？（准备对比表）',
      '下一步最可能失败在哪？（准备止损方案）',
    ], '待补'),
  })

  const markdown = [
    `# ${title}`,
    '',
    `> 由 ekko 研究工作台生成（${new Date().toISOString()}）。结构是真实的，讲稿槽位标了「待补」，交给 Agent 补全。`,
    '',
    ...slides.map((slide, index) => [
      `## ${index + 1}. ${slide.heading}`,
      '',
      slide.body,
      '',
      '<details><summary>讲稿（60-90 秒）</summary>',
      '',
      '待补：口语化讲法，先结论后细节。',
      '',
      '</details>',
      '',
    ].join('\n')),
    '<!-- 交给 Agent：按「待补」逐项补讲稿，不要改标题与结构；补完把本文件写回同一路径。 -->',
    '',
  ].join('\n')

  const dir = path.join(projectDir(projectId, profile), 'decks')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  // Two decks in the same second must not overwrite each other.
  const suffix = Math.random().toString(36).slice(2, 6)
  const base = path.join(dir, `deck-${stamp}-${suffix}`)
  const file = `${base}.md`
  await fs.writeFile(file, markdown, 'utf-8')
  // 真正的幻灯片：用户点「生成组会 PPT」拿到的应该是这个，.md 只是讲稿源。
  const pptxFile = `${base}.pptx`
  const buffer = await renderDeckPptx({
    title,
    subtitle: `${project.title} · ${new Date().toISOString().slice(0, 10)}`
      + ` · 文献 ${papers.length} 篇 / 实验 ${experiments.length} 条 / 图表 ${figures.length} 张`,
    slides,
  })
  await fs.writeFile(pptxFile, buffer)

  const deck: ResearchDeck = {
    id: newId('deck'),
    projectId,
    title,
    path: pptxFile,
    at: Date.now(),
    paperIds: chosen.map(item => item.id),
    pages: slides.length,
  }
  return { deck, path: pptxFile, markdown }
}

/** The deck file's raw bytes (pptx) plus its on-disk name, for the download route. */
export async function readDeckBytes(
  projectId: string,
  deckId: string,
  profile?: string,
): Promise<{ deck: ResearchDeck; bytes: Buffer; file: string }> {
  const store = await readStore(profile)
  const deck = store.decks.find(item => item.id === deckId && item.projectId === projectId)
  if (!deck) throw new Error('deck_not_found')
  let resolved: string
  try {
    resolved = deckFilePath(projectId, deck.path, profile)
  } catch {
    throw new Error('deck_path_invalid')
  }
  const bytes = await fs.readFile(resolved)
  return { deck, bytes, file: path.basename(resolved) }
}

export interface DeckListItem {
  readonly id: string
  readonly file: string
  readonly sizeBytes: number
  readonly at: number
}

/**
 * List one project's generated decks, newest first, with the on-disk size.
 * A deck whose file was moved by hand still lists (size 0) so the panel can
 * delete the record instead of hiding it.
 */
export async function listDecks(projectId: string, profile?: string): Promise<DeckListItem[]> {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid_project_id')
  const store = await readStore(profile)
  const rows = store.decks
    .filter(item => item.projectId === projectId)
    .sort((a, b) => b.at - a.at)
  const out: DeckListItem[] = []
  for (const deck of rows) {
    let sizeBytes = 0
    let at = deck.at
    try {
      const stat = await fs.stat(deckFilePath(projectId, deck.path, profile))
      sizeBytes = stat.size
      if (stat.mtimeMs > 0) at = stat.mtimeMs
    } catch {
      // Missing file: keep the record visible with size 0.
    }
    out.push({ id: deck.id, file: path.basename(deck.path), sizeBytes, at })
  }
  return out
}

export interface DeckFile {
  deck: ResearchDeck
  markdown: string
  /** False when the record survived but the .md was moved or deleted. */
  exists: boolean
}

/**
 * Read a generated deck back for the panel's preview.
 *
 * `state.json` is hand-editable, so the stored `path` is treated as untrusted:
 * only files inside this project's `decks/` are ever opened.
 */
/** Resolve a stored deck path, refusing anything outside this project's decks/. */
function deckFilePath(projectId: string, stored: string, profile?: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid_project_id')
  if (!stored) throw new Error('deck_path_invalid')
  const decksDir = path.join(projectDir(projectId, profile), 'decks')
  const resolved = path.resolve(stored)
  if (!resolved.startsWith(`${decksDir}${path.sep}`)) throw new Error('deck_path_invalid')
  return resolved
}

export async function readDeck(
  projectId: string,
  deckId: string,
  profile?: string,
): Promise<DeckFile> {
  const store = await readStore(profile)
  const deck = store.decks.find(item => item.id === deckId && item.projectId === projectId)
  if (!deck) throw new Error('deck_not_found')

  let resolved: string
  try {
    resolved = deckFilePath(projectId, deck.path, profile)
  } catch {
    throw new Error('deck_path_invalid')
  }

  // 记录指向 pptx 时讲稿是同目录同名的 .md；直接读 pptx 会得到一段乱码。
  const source = resolved.toLowerCase().endsWith('.pptx')
    ? `${resolved.slice(0, -'.pptx'.length)}.md`
    : resolved

  try {
    const markdown = await fs.readFile(source, 'utf-8')
    return { deck, markdown, exists: true }
  } catch {
    return { deck, markdown: '', exists: false }
  }
}

/**
 * Delete the markdown behind a deck record. Called after the record is gone so
 * `decks/` never keeps an orphan the panel can no longer reach.
 */
export async function removeDeckFile(
  record: Record<string, unknown>,
  profile?: string,
): Promise<boolean> {
  const projectId = typeof record.projectId === 'string' ? record.projectId : ''
  const stored = typeof record.path === 'string' ? record.path : ''
  let resolved: string
  try {
    resolved = deckFilePath(projectId, stored, profile)
  } catch {
    return false
  }
  try {
    await fs.rm(resolved, { force: true })
    return true
  } catch {
    return false
  }
}
