/**
 * 组会汇报预览的数据入口：面板手上只有文件名，服务端要的是 deckId，所以
 * 先按文件名在列表里找到记录，再取那份额汇报的页结构。同一份汇报重复打开
 * 走内存缓存，避免每次翻页都重新解析 pptx。
 */
import {
  fetchResearchDeckPreview,
  fetchResearchDecks,
  type ResearchDeckPreview,
} from '@/api/studio/research'

const cache = new Map<string, ResearchDeckPreview>()
const inflight = new Map<string, Promise<ResearchDeckPreview>>()

function keyOf(projectId: string, file: string): string {
  return `${projectId}:${file}`
}

/**
 * 取一份汇报的预览（页 + 每页的矩形/文本框）。
 * @param projectId - 项目 id。
 * @param file - 汇报文件名，与列表里显示的一致。
 * @returns 幻灯片结构，可直接交给 `DeckPreviewOverlay` 渲染。
 */
export async function loadDeckPreview(projectId: string, file: string): Promise<ResearchDeckPreview> {
  const key = keyOf(projectId, file)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const running = inflight.get(key)
  if (running !== undefined) return running

  const task = (async (): Promise<ResearchDeckPreview> => {
    const decks = await fetchResearchDecks(projectId)
    const hit = decks.find(item => item.file === file)
    if (hit === undefined) throw new Error('deck_not_found')
    const preview = await fetchResearchDeckPreview(projectId, hit.id)
    cache.set(key, preview)
    return preview
  })()
  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

/** 汇报被删掉后，缓存里的那份预览不能再用。 */
export function forgetDeckPreview(projectId: string, file: string): void {
  cache.delete(keyOf(projectId, file))
}
