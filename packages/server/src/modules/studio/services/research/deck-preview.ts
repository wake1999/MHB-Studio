/**
 * 组会汇报的预览数据：把磁盘上的 `.pptx` 拆成「一页 = 若干矩形 / 文本框」的
 * 平面结构，前端按比例铺成 16:9 卡片就是幻灯片本身。
 *
 * 为什么在服务端做：浏览器不能渲染 pptx，而把 pptxgenjs 那套解析搬进前端
 * 要多一个 zip + XML 依赖；磁盘上的文件本来就在服务端手边。
 *
 * 坐标与字号都以「幻灯片宽度的百分比」给出（前端直接当 cqw 用）：
 * - 位置/尺寸：0..1 的宽高比例；
 * - 字号/缩进/段后：幻灯片宽度的百分比（1pt = 100 / (宽英寸 * 72)）。
 *
 * 旧记录指向 `.md`（pptx 上线前的产物）时按 `deck-pptx.ts` 的同一套版式常量
 * 还原，保证新旧产物在预览里长得一样。
 *
 * `jszip` 是 pptxgenjs 的传递依赖，已随它落在根 package-lock 里，这里不重复声明。
 */
import JSZip from 'jszip'

import { readDeck, readDeckBytes } from './deck'

/** 一页里的文字片段（同一段内可多段不同样式）。 */
export interface DeckPreviewRun {
  readonly t: string
  /** 字号，幻灯片宽度的百分比。 */
  readonly sz: number
  readonly b: boolean
  /** `RRGGBB` 不含 `#`。 */
  readonly c: string
}

export interface DeckPreviewPara {
  readonly runs: readonly DeckPreviewRun[]
  /** true 时前端画圆点，并按 `indent` 做悬挂缩进。 */
  readonly bullet: boolean
  readonly indent: number
  readonly lineHeight: number
  readonly spaceAfter: number
  readonly align: 'l' | 'ctr' | 'r'
}

export interface DeckPreviewShape {
  readonly kind: 'text' | 'rect'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly anchor: 't' | 'ctr' | 'b'
  readonly fill?: string
  readonly paras?: readonly DeckPreviewPara[]
}

export interface DeckPreviewPage {
  readonly shapes: readonly DeckPreviewShape[]
}

export interface DeckPreview {
  readonly file: string
  readonly kind: 'pptx' | 'markdown'
  /** 宽 / 高，前端拿来锁 aspect-ratio。 */
  readonly aspect: number
  readonly pages: readonly DeckPreviewPage[]
}

/** 版式常量与 `deck-pptx.ts` 保持一致：改那边就要改这里。 */
const INK = '111827'
const BODY_INK = '374151'
const RULE = 'E5E7EB'
const ACCENT = '1D4ED8'

/** LAYOUT_WIDE：13.333 × 7.5 英寸。 */
const WIDE_CX = 12192000
const WIDE_CY = 6858000
const EMU_PER_INCH = 914400

/** 幻灯片宽度里，1pt 占多少百分比。 */
function ptToCqw(cx: number): number {
  return (100 * EMU_PER_INCH) / (cx * 72)
}

/** 幻灯片宽度里，1EMU 占多少百分比。 */
function emuToCqw(cx: number): number {
  return 100 / cx
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 读一个标签里的属性（`attr('<a:off x="1"/>', 'x')`）。 */
function attr(tag: string, name: string): string | null {
  const hit = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return hit ? hit[1] : null
}

function num(value: string | null | undefined, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function colorIn(scope: string): string | null {
  const hit = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(scope)
  return hit ? hit[1].toUpperCase() : null
}

/** 把一段 `<a:p>…</a:p>` 拆成 run + 段落属性。 */
function parseParagraph(block: string, cx: number): DeckPreviewPara | null {
  const runs: DeckPreviewRun[] = []
  const runRe = /<a:r>([\s\S]*?)<\/a:r>/g
  let hit: RegExpExecArray | null
  while ((hit = runRe.exec(block)) !== null) {
    const body = hit[1]
    const textHit = /<a:t>([\s\S]*?)<\/a:t>/.exec(body)
    if (!textHit) continue
    const text = decodeXml(textHit[1])
    if (text === '') continue
    const rPr = /<a:rPr[^>]*>/.exec(body)
    const tag = rPr ? rPr[0] : ''
    const sizePt = num(attr(tag, 'sz'), 1800) / 100
    runs.push({
      t: text,
      sz: round(sizePt * ptToCqw(cx)),
      b: attr(tag, 'b') === '1',
      c: colorIn(body) ?? BODY_INK,
    })
  }
  if (runs.length === 0) return null

  const pPr = /<a:pPr[^>]*>/.exec(block)
  const pTag = pPr ? pPr[0] : ''
  const marL = num(attr(pTag, 'marL'))
  const indent = num(attr(pTag, 'indent'))
  const bullet = !/<a:buNone\s*\/>/.test(block.slice(0, block.indexOf('<a:r>')))
  const lnHit = /<a:spcPct val="(\d+)"/.exec(block)
  const aftHit = /<a:spcPts val="(\d+)"/.exec(block)
  const algn = attr(pTag, 'algn')

  return {
    runs,
    bullet,
    indent: round(Math.abs(Math.min(indent, 0)) * emuToCqw(cx)),
    lineHeight: lnHit ? round(num(lnHit[1]) / 100000) : 1.15,
    spaceAfter: round((aftHit ? num(aftHit[1]) / 100 : 0) * ptToCqw(cx)),
    align: algn === 'ctr' ? 'ctr' : algn === 'r' ? 'r' : 'l',
  }
}

/** 一个 `<p:sp>`：有 `p:txBody` 当文本框，否则当填充矩形。 */
function parseShape(block: string, cx: number, cy: number): DeckPreviewShape | null {
  // 属性顺序按 spec 是固定的，但别处写出的 pptx 未必守规矩，逐个取更稳。
  const offTag = /<a:off[^>]*>/.exec(block)
  const extTag = /<a:ext[^>]*>/.exec(block)
  if (!offTag || !extTag) return null
  const x = num(attr(offTag[0], 'x')) / cx
  const y = num(attr(offTag[0], 'y')) / cy
  const w = num(attr(extTag[0], 'cx')) / cx
  const h = num(attr(extTag[0], 'cy')) / cy
  if (w <= 0 || h <= 0) return null

  const bodyHit = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(block)
  if (bodyHit === null) {
    const spPr = /<p:spPr>([\s\S]*?)<\/p:spPr>/.exec(block)
    const fill = spPr ? colorIn(spPr[1]) : null
    if (fill === null) return null
    return { kind: 'rect', x: round(x), y: round(y), w: round(w), h: round(h), anchor: 't', fill }
  }

  const body = bodyHit[1]
  const bodyPr = /<a:bodyPr[^>]*>/.exec(body)
  const anchorAttr = bodyPr ? attr(bodyPr[0], 'anchor') : null
  const paraRe = /<a:p>([\s\S]*?)<\/a:p>/g
  const paras: DeckPreviewPara[] = []
  let hit: RegExpExecArray | null
  while ((hit = paraRe.exec(body)) !== null) {
    const para = parseParagraph(hit[1], cx)
    if (para !== null) paras.push(para)
  }
  if (paras.length === 0) return null
  return {
    kind: 'text',
    x: round(x),
    y: round(y),
    w: round(w),
    h: round(h),
    anchor: anchorAttr === 'ctr' ? 'ctr' : anchorAttr === 'b' ? 'b' : 't',
    paras,
  }
}

/** `.pptx` → 页结构：按 `presentation.xml` 的 sldIdLst 顺序取 slide 文件。 */
async function parsePptx(buffer: Buffer): Promise<{ aspect: number; pages: DeckPreviewPage[] }> {
  const zip = await JSZip.loadAsync(buffer)
  const presFile = zip.file('ppt/presentation.xml')
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels')
  if (!presFile || !relsFile) throw new Error('deck_preview_unreadable')
  const pres = await presFile.async('string')
  const rels = await relsFile.async('string')

  const sizeHit = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(pres)
  const cx = sizeHit ? num(sizeHit[1], WIDE_CX) : WIDE_CX
  const cy = sizeHit ? num(sizeHit[2], WIDE_CY) : WIDE_CY

  const relMap = new Map<string, string>()
  const relRe = /<Relationship\b[^>]*>/g
  let rel: RegExpExecArray | null
  while ((rel = relRe.exec(rels)) !== null) {
    const id = attr(rel[0], 'Id')
    const target = attr(rel[0], 'Target')
    if (id !== null && target !== null && /slides\/slide\d+\.xml$/.test(target)) relMap.set(id, target)
  }

  const order: string[] = []
  const idRe = /<p:sldId\b[^>]*r:id="([^"]+)"/g
  let sldId: RegExpExecArray | null
  while ((sldId = idRe.exec(pres)) !== null) {
    const target = relMap.get(sldId[1])
    if (target !== undefined) order.push(`ppt/${target}`)
  }
  if (order.length === 0) {
    // 没有 sldIdLst 时按文件编号兜底，宁可顺序可能不准，也别给空白预览。
    order.push(...Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => num(/(\d+)\.xml$/.exec(a)?.[1], 0) - num(/(\d+)\.xml$/.exec(b)?.[1], 0)))
  }

  const pages: DeckPreviewPage[] = []
  for (const name of order) {
    const file = zip.file(name)
    if (!file) continue
    const xml = await file.async('string')
    const shapes: DeckPreviewShape[] = []
    const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g
    let sp: RegExpExecArray | null
    while ((sp = spRe.exec(xml)) !== null) {
      const shape = parseShape(sp[1], cx, cy)
      if (shape !== null) shapes.push(shape)
    }
    pages.push({ shapes })
  }
  return { aspect: round(cx / cy), pages }
}

function textShape(input: {
  x: number; y: number; w: number; h: number
  anchor: 't' | 'ctr' | 'b'
  size: number
  bold: boolean
  color: string
  lines: readonly string[]
  bullet: boolean
  indent: number
  lineHeight: number
  spaceAfter: number
}): DeckPreviewShape {
  const paras: DeckPreviewPara[] = input.lines.map((line) => ({
    runs: [{ t: line, sz: input.size, b: input.bold, c: input.color }],
    bullet: input.bullet,
    indent: input.bullet ? input.indent : 0,
    lineHeight: input.lineHeight,
    spaceAfter: input.spaceAfter,
    align: 'l',
  }))
  return {
    kind: 'text',
    x: round(input.x / 13.3333),
    y: round(input.y / 7.5),
    w: round(input.w / 13.3333),
    h: round(input.h / 7.5),
    anchor: input.anchor,
    paras,
  }
}

function rectShape(x: number, y: number, w: number, h: number, fill: string): DeckPreviewShape {
  return {
    kind: 'rect',
    x: round(x / 13.3333),
    y: round(y / 7.5),
    w: round(w / 13.3333),
    h: round(h / 7.5),
    anchor: 't',
    fill,
  }
}

/** `deck-pptx.ts` 的正文分级：行越多字越小。 */
function bodyFontSize(lines: number): number {
  if (lines > 16) return 11
  if (lines > 12) return 13
  if (lines > 8) return 15
  return 17
}

const PT_CQW = ptToCqw(WIDE_CX)

/** 讲稿 markdown → 与 pptx 同一套版式的页结构。 */
function parseMarkdownDeck(markdown: string): DeckPreviewPage[] {
  const pages: DeckPreviewPage[] = []
  const lines = markdown.split('\n')
  const title = (lines.find(line => line.startsWith('# ')) ?? '').slice(2).trim() || '组会汇报'
  const subtitle = (lines.find(line => line.startsWith('> ')) ?? '').slice(2).trim()

  pages.push({
    shapes: [
      textShape({
        x: 0.7, y: 2.1, w: 12, h: 1.1, anchor: 'ctr',
        size: 34 * PT_CQW, bold: true, color: INK, lines: [title],
        bullet: false, indent: 0, lineHeight: 1.15, spaceAfter: 0,
      }),
      rectShape(0.7, 3.15, 1.6, 0.06, ACCENT),
      ...(subtitle === '' ? [] : [textShape({
        x: 0.7, y: 3.3, w: 12, h: 1.2, anchor: 'ctr',
        size: 15 * PT_CQW, bold: false, color: BODY_INK, lines: [subtitle],
        bullet: false, indent: 0, lineHeight: 1.15, spaceAfter: 0,
      })]),
    ],
  })

  const sections: Array<{ heading: string; body: string[] }> = []
  let current: { heading: string; body: string[] } | null = null
  let inDetails = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('<details')) { inDetails = true; continue }
    if (line.startsWith('</details')) { inDetails = false; continue }
    if (inDetails) continue
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).replace(/^\d+\.\s*/, '').trim(), body: [] }
      sections.push(current)
      continue
    }
    if (current === null) continue
    if (line === '' || line.startsWith('#') || line.startsWith('>') || line.startsWith('<!--')) continue
    current.body.push(line.replace(/^[-*]\s*/, ''))
  }

  for (const section of sections) {
    const body = section.body
    const size = bodyFontSize(body.length) * PT_CQW
    const shapes: DeckPreviewShape[] = [
      textShape({
        x: 0.6, y: 0.42, w: 12.1, h: 0.8, anchor: 'ctr',
        size: 26 * PT_CQW, bold: true, color: INK, lines: [section.heading],
        bullet: false, indent: 0, lineHeight: 1.15, spaceAfter: 0,
      }),
      rectShape(0.6, 1.28, 12.1, 0.02, RULE),
    ]
    if (body.length === 0) {
      shapes.push(textShape({
        x: 0.65, y: 1.6, w: 12, h: 0.6, anchor: 't',
        size: 16 * PT_CQW, bold: false, color: BODY_INK, lines: ['（这一页还没有内容）'],
        bullet: false, indent: 0, lineHeight: 1.15, spaceAfter: 0,
      }))
    } else {
      // 与 deck-pptx.ts 的 paragraphsOf 一致：`决策：` 这类短标签加粗走强调色。
      const paras: DeckPreviewPara[] = body.map((line) => {
        const label = /^[^：:]{1,12}[：:]$/.test(line)
        return {
          runs: [{ t: line, sz: size, b: label, c: label ? ACCENT : BODY_INK }],
          bullet: !label,
          indent: label ? 0 : 0.375 * 100 / 13.3333,
          lineHeight: 1.25,
          spaceAfter: 6 * PT_CQW,
          align: 'l' as const,
        }
      })
      shapes.push({
        kind: 'text',
        x: round(0.65 / 13.3333),
        y: round(1.55 / 7.5),
        w: round(12.05 / 13.3333),
        h: round(5.4 / 7.5),
        anchor: 't',
        paras,
      })
    }
    pages.push({ shapes })
  }
  return pages
}

/**
 * 一份汇报的预览。pptx 解不出来（文件被换过、生成器升级）时退回同名讲稿，
 * 面板至少能看到文字，不至于点「预览」只得到一条错误。
 */
export async function buildDeckPreview(
  projectId: string,
  deckId: string,
  profile?: string,
): Promise<DeckPreview> {
  const { bytes, file } = await readDeckBytes(projectId, deckId, profile)
  if (file.toLowerCase().endsWith('.pptx')) {
    try {
      const parsed = await parsePptx(bytes)
      if (parsed.pages.length > 0) {
        return { file, kind: 'pptx', aspect: parsed.aspect, pages: parsed.pages }
      }
    } catch {
      // 落到下面的 markdown 分支。
    }
  } else {
    const text = bytes.toString('utf-8')
    return { file, kind: 'markdown', aspect: round(WIDE_CX / WIDE_CY), pages: parseMarkdownDeck(text) }
  }

  const fallback = await readDeck(projectId, deckId, profile)
  if (fallback.markdown.trim() === '') throw new Error('deck_preview_unreadable')
  return {
    file,
    kind: 'markdown',
    aspect: round(WIDE_CX / WIDE_CY),
    pages: parseMarkdownDeck(fallback.markdown),
  }
}
