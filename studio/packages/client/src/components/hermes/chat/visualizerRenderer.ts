/**
 * Inline visuals: assistant replies can carry a self-contained `svg` or `html`
 * fence and the chat renders it in place instead of printing source code.
 *
 * Two shapes, two strategies:
 * - `svg` is sanitized and inlined, so a streaming diagram grows smoothly.
 * - `html` runs inside a sandboxed iframe without `allow-same-origin`, so the
 *   widget cannot touch the host page, its storage, or its cookies.
 *
 * Everything here is pure string/DOM work; mounting lives in MarkdownRenderer.
 */

export type VisualFenceKind = 'svg' | 'html'

const VISUAL_FENCE_LANGUAGES: Record<string, VisualFenceKind> = {
  svg: 'svg',
  svgz: 'svg',
  'svg+xml': 'svg',
  'image/svg+xml': 'svg',
  xml: 'svg',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  'html-artifact': 'html',
}

export const VISUAL_MAX_BLOCKS_PER_MESSAGE = 6
export const VISUAL_MAX_SOURCE_LENGTH = 200_000
export const VISUAL_RESIZE_MESSAGE_TYPE = 'ekko-visual-resize'
export const VISUAL_IDLE_RENDER_DELAY_MS = 220
export const VISUAL_MIN_FRAME_HEIGHT = 48
export const VISUAL_MAX_FRAME_HEIGHT = 4_000
export const VISUAL_DEFAULT_FRAME_HEIGHT = 160

const BLOCKED_SVG_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
])

const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'poster'])

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function getVisualFenceLanguage(info: string | undefined): string {
  return info?.trim().split(/\s+/)[0]?.toLowerCase() || ''
}

export function getVisualFenceKind(info: string | undefined): VisualFenceKind | null {
  return VISUAL_FENCE_LANGUAGES[getVisualFenceLanguage(info)] ?? null
}

export function encodeVisualSource(source: string): string {
  return encodeURIComponent(source)
}

export function decodeVisualSource(encoded: string | null | undefined): string {
  if (!encoded) return ''
  try {
    return decodeURIComponent(encoded)
  } catch {
    return ''
  }
}

/**
 * A stable key per rendered artefact. Streaming re-renders replace the whole
 * markdown DOM, so the mount step looks the key up and re-parents the existing
 * node instead of rebuilding the iframe (which would reload and flash).
 */
export function visualSourceFingerprint(kind: VisualFenceKind, source: string): string {
  let hash = 5381
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0
  }
  return `${kind}:${source.length}:${(hash >>> 0).toString(36)}`
}

export function renderVisualPlaceholder(kind: VisualFenceKind, source: string): string {
  return [
    `<div class="ekko-visual ekko-visual-${kind}" data-visual-pending="${kind}"`,
    ` data-visual-source="${escapeHtml(encodeVisualSource(source))}">`,
    '<div class="ekko-visual-loading"><span></span><span></span><span></span></div>',
    '</div>',
  ].join('')
}

/**
 * SVG is inlined into the chat, so it has to be inert: no scripts, no embedded
 * documents, no event handlers, and no URLs that could fetch or execute.
 * Unparseable markup (a fence still streaming in) yields an empty string and
 * the caller keeps waiting instead of showing a broken image.
 */
export function sanitizeSvgSource(source: string): string {
  if (typeof DOMParser === 'undefined') return ''

  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') return ''
  if (parsed.querySelector('parsererror')) return ''

  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (BLOCKED_SVG_ELEMENTS.has(element.nodeName.toLowerCase())) {
      element.remove()
      continue
    }

    if (element.nodeName.toLowerCase() === 'style' && /@import|javascript:/i.test(element.textContent ?? '')) {
      element.remove()
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()

      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }

      if (URL_ATTRIBUTES.has(name) && /^(javascript|vbscript|data:text\/html)/i.test(value)) {
        element.removeAttribute(attribute.name)
        continue
      }

      if (name === 'style' && /expression\(|javascript:|@import/i.test(value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  for (const attribute of Array.from(root.attributes)) {
    if (attribute.name.toLowerCase().startsWith('on')) root.removeAttribute(attribute.name)
  }

  return new XMLSerializer().serializeToString(root)
}

/**
 * The iframe document. `color-scheme` plus `prefers-color-scheme` lets a
 * generated widget follow the host theme without passing tokens across the
 * sandbox boundary; the resize bridge reports its own height because the parent
 * cannot read into a frame that has no same-origin access.
 */
export function buildVisualDocument(source: string, frameId: string, dark = false): string {
  const scriptClose = `<${'/script'}>`
  const bridge = [
    '<script>(function(){',
    `var id=${JSON.stringify(frameId)};`,
    `function post(){try{var h=document.documentElement.scrollHeight||document.body.scrollHeight;`,
    `parent.postMessage({type:"${VISUAL_RESIZE_MESSAGE_TYPE}",id:id,height:Math.ceil(h)},"*")}catch(e){}}`,
    'if(window.ResizeObserver){try{new ResizeObserver(post).observe(document.documentElement)}catch(e){}}',
    'window.addEventListener("load",post);',
    'setTimeout(post,60);setTimeout(post,400);',
    '})()',
    scriptClose,
  ].join('')

  return [
    `<!doctype html><html${dark ? ' data-theme="dark"' : ''}><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>',
    'html,body{margin:0;padding:0;background:transparent;color-scheme:light dark}',
    'body{font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;padding:2px;overflow-wrap:anywhere}',
    '@media (prefers-color-scheme: dark){body{color:#e6edf3}}',
    'html[data-theme="dark"]{color-scheme:dark}',
    'html[data-theme="dark"] body{color:#e6edf3}',
    'img,svg,video,canvas{max-width:100%;height:auto}',
    'table{border-collapse:collapse}td,th{border:1px solid rgba(127,127,127,.35);padding:4px 8px}',
    'button{font:inherit}',
    '</style></head><body>',
    source,
    bridge,
    '</body></html>',
  ].join('')
}

/**
 * 逃生通道：模型偶尔把 <svg> 裸写在正文里，而 markdown-it 配置了 html:false，
 * 裸 HTML 会被转义成源码文本。这里把围栏外的裸 <svg>...</svg> 包成 ```svg 围栏，
 * 让它走正常的 visual 渲染路径（仍是纯字符串处理，不放开 html:true）。
 */
export function wrapBareSvgFences(source: string): string {
  if (!source || source.indexOf('<svg') === -1) return source
  const svgRe = /<svg\b[\s\S]*?<\/svg>/gi
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = svgRe.exec(source)) !== null) {
    const fencesBefore = (source.slice(0, m.index).match(/```/g) || []).length
    if (fencesBefore % 2 === 1) continue
    out += source.slice(last, m.index) + '\n```svg\n' + m[0] + '\n```\n'
    last = m.index + m[0].length
  }
  if (!last) return source
  return out + source.slice(last)
}
