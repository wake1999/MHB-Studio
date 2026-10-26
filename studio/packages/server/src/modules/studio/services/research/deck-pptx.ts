/**
 * 组会 PPTX 渲染：把 `deck.ts` 里那份结构化讲稿（标题 + 每页 heading/body）
 * 排成真正的 PowerPoint 文件，交给 `buildDeck` 落盘。
 *
 * Markdown 版本仍会写在同一目录（`deck-*.md`），供 Agent 补讲稿；但落库的
 * 记录与下载都指向 `.pptx`，避免用户点「生成组会 PPT」拿到一个 .md。
 */
import PptxGen from 'pptxgenjs'

export interface DeckPptxSlide {
  readonly heading: string
  readonly body: string
}

const FONT = 'Microsoft YaHei'
const INK = '111827'
const BODY_INK = '374151'
const RULE = 'E5E7EB'
const ACCENT = '1D4ED8'

/** One body line as a paragraph; `决策：` style lines become bold labels. */
function paragraphsOf(body: string): Array<{ text: string; options: Record<string, unknown> }> {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const plain = line.replace(/^[-*]\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1')
      const label = /^[^：:]{1,12}[：:]$/.test(plain)
      return {
        text: plain,
        options: label
          ? { bold: true, color: ACCENT, fontSize: 18, bullet: false }
          : { bullet: true, color: BODY_INK },
      }
    })
}

/** Body font size shrinks as a page gets crowded, so nothing spills off. */
function bodyFontSize(lines: number): number {
  if (lines > 16) return 11
  if (lines > 12) return 13
  if (lines > 8) return 15
  return 17
}

export async function renderDeckPptx(input: {
  readonly title: string
  readonly subtitle: string
  readonly slides: readonly DeckPptxSlide[]
}): Promise<Buffer> {
  const Ctor: any = (PptxGen as any)?.default ?? PptxGen
  const pptx = new Ctor()
  try {
    pptx.layout = 'LAYOUT_WIDE'
  } catch {
    // Older builds default to 4:3; text boxes below already fit that width.
  }

  const cover = pptx.addSlide()
  cover.addText(input.title, {
    x: 0.7, y: 2.1, w: 12, h: 1.1, fontSize: 34, bold: true, color: INK, fontFace: FONT,
  })
  cover.addText(input.subtitle, {
    x: 0.7, y: 3.3, w: 12, h: 1.2, fontSize: 15, color: BODY_INK, fontFace: FONT,
  })
  cover.addShape('rect', {
    x: 0.7, y: 3.15, w: 1.6, h: 0.06, fill: { color: ACCENT },
  })

  for (const slide of input.slides) {
    const page = pptx.addSlide()
    page.addText(slide.heading, {
      x: 0.6, y: 0.42, w: 12.1, h: 0.8, fontSize: 26, bold: true, color: INK, fontFace: FONT,
    })
    page.addShape('rect', {
      x: 0.6, y: 1.28, w: 12.1, h: 0.02, fill: { color: RULE },
    })
    const lines = paragraphsOf(slide.body)
    if (lines.length === 0) {
      page.addText('（这一页还没有内容）', {
        x: 0.65, y: 1.6, w: 12, h: 0.6, fontSize: 16, color: BODY_INK, fontFace: FONT,
      })
      continue
    }
    page.addText(lines, {
      x: 0.65,
      y: 1.55,
      w: 12.05,
      h: 5.4,
      fontSize: bodyFontSize(lines.length),
      fontFace: FONT,
      valign: 'top',
      lineSpacingMultiple: 1.25,
      paraSpaceAfter: 6,
      color: BODY_INK,
    })
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer)
}
