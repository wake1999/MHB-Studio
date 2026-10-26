/**
 * 组会汇报文件的本地缓存：上游 `<a download>` 带不了 Bearer，所以适配层在
 * `listMeetingDecks` 里用已鉴权的接口取回每个 deck 的原始字节（pptx），转成
 * object URL 存这里，再由上游 `meetingDeckUrl()` 从缓存取地址（见 view-common.ts）。
 *
 * 键是 `<projectId>:<file>`；重新生成同名文件时先释放旧 URL。
 */

const cache = new Map<string, string>()

function keyOf(projectId: string, file: string): string {
  return `${projectId}:${file}`
}

/** 登记一份已取回的汇报文件，返回可下载的 object URL。 */
export function registerDeckBlob(projectId: string, file: string, content: Blob | string): string {
  const key = keyOf(projectId, file)
  const previous = cache.get(key)
  if (previous) URL.revokeObjectURL(previous)
  const blob = typeof content === 'string'
    ? new Blob([content], { type: 'text/markdown;charset=utf-8' })
    : content
  const url = URL.createObjectURL(blob)
  cache.set(key, url)
  return url
}

/** 供上游 `meetingDeckUrl()` 使用：有缓存给 object URL，没有给空串。 */
export function deckBlobUrl(projectId: string, file: string): string {
  return cache.get(keyOf(projectId, file)) ?? ''
}
