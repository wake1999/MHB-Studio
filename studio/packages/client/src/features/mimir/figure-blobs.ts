/**
 * 图片的本地缓存：上游 `<img src>` 走不了带 Bearer 的请求，所以适配层在
 * `listFigures` 里用已鉴权的 requestBlob 把图片取回来，转成 object URL 存这里，
 * 再由上游 `figureUrl()` 从缓存里取地址（见 view-common.ts 的同名函数）。
 *
 * 键是 `<projectId>:<relPath>`；同一条记录更新（`at` 变了）就重新取一次。
 */

interface FigureBlobEntry {
  readonly url: string
  readonly size: number
  readonly at: number
}

const cache = new Map<string, FigureBlobEntry>()

function keyOf(projectId: string, relPath: string): string {
  return `${projectId}:${relPath}`
}

export function figureBlobEntry(projectId: string, relPath: string): FigureBlobEntry | null {
  return cache.get(keyOf(projectId, relPath)) ?? null
}

/** 登记一份已取回的图片；旧的 object URL 先释放，避免泄漏。 */
export function registerFigureBlob(
  projectId: string,
  relPath: string,
  at: number,
  blob: Blob,
): FigureBlobEntry {
  const key = keyOf(projectId, relPath)
  const previous = cache.get(key)
  if (previous) URL.revokeObjectURL(previous.url)
  const entry: FigureBlobEntry = { url: URL.createObjectURL(blob), size: blob.size, at }
  cache.set(key, entry)
  return entry
}

/** 供上游 `figureUrl()` 使用：有缓存给 object URL，没有给空串（走它自己的回退）。 */
export function figureBlobUrl(projectId: string, relPath: string): string {
  return cache.get(keyOf(projectId, relPath))?.url ?? ''
}
