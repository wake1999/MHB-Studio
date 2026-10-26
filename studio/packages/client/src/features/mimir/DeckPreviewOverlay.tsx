/**
 * 组会汇报的幻灯片预览：服务端把 pptx 拆成「每页 + 绝对定位的文本框 / 色块」，
 * 这里按同一套几何铺进一张 16:9 的卡片。字号与缩进都是「幻灯片宽度的百分比」，
 * 直接当容器查询单位（cqw）用，缩放窗口时版式不散、也不需要量 DOM。
 *
 * 渲染进 portal：工作台的祖先带 transform / backdrop-filter，会把 fixed 遮罩
 * 困在局部坐标系里，和 PDF 阅读器、导入对话框是同一个坑。
 * @module dsh-client-ui-mimir/client/DeckPreviewOverlay
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ResearchDeckPreview,
  ResearchDeckPreviewPara,
  ResearchDeckPreviewShape,
} from '@/api/studio/research'
import { loadDeckPreview } from './deck-preview.ts'
import { meetingDeckUrl, type ResearchT } from './view-common.ts'
import css from './ResearchPanel.module.css'

/** 0..1 的比例 → CSS 定位值（保留四位小数，缩放时不会累积误差）。 */
function pct(value: number): string {
  return `${(value * 100).toFixed(4)}%`
}

/** 一段文字：悬挂缩进 + 可选圆点，run 自带字号/字重/颜色。 */
function DeckParagraph({ para }: {
  readonly para: ResearchDeckPreviewPara
}) {
  const align = para.align === 'ctr' ? 'center' : para.align === 'r' ? 'right' : 'left'
  const dotSize = para.runs.length > 0 ? para.runs[0].sz : 0
  return (
    <div
      className={css.deckPara}
      style={{
        textAlign: align,
        lineHeight: para.lineHeight,
        marginBottom: `${para.spaceAfter}cqw`,
        paddingLeft: para.bullet ? `${para.indent}cqw` : undefined,
      }}
    >
      {para.bullet && (
        <span
          className={css.deckDot}
          style={{ fontSize: `${dotSize}cqw`, lineHeight: para.lineHeight }}
          aria-hidden="true"
        >
          •
        </span>
      )}
      {para.runs.map((run, index) => (
        <span
          key={index}
          style={{ fontSize: `${run.sz}cqw`, fontWeight: run.b ? 700 : 400, color: `#${run.c}` }}
        >
          {run.t}
        </span>
      ))}
    </div>
  )
}

/** 一个形状：填充矩形（分隔线 / 色块）或文本框。 */
function DeckShape({ shape }: {
  readonly shape: ResearchDeckPreviewShape
}) {
  const box = { left: pct(shape.x), top: pct(shape.y), width: pct(shape.w), height: pct(shape.h) }
  if (shape.kind === 'rect') {
    return <div className={css.deckRect} style={{ ...box, background: `#${shape.fill ?? 'E5E7EB'}` }} />
  }
  return (
    <div
      className={css.deckText}
      style={{
        ...box,
        justifyContent: shape.anchor === 'ctr' ? 'center' : shape.anchor === 'b' ? 'flex-end' : 'flex-start',
      }}
    >
      {(shape.paras ?? []).map((para, index) => <DeckParagraph key={index} para={para} />)}
    </div>
  )
}

/**
 * @param props - 项目 id、汇报文件名、关闭回调与文案。
 * @returns 全屏浮层里的一页一页幻灯片，←/→ 翻页，Esc 关闭。
 */
export function DeckPreviewOverlay({ projectId, file, t, onClose }: {
  readonly projectId: string
  readonly file: string
  readonly t: ResearchT
  readonly onClose: () => void
}) {
  const [preview, setPreview] = useState<ResearchDeckPreview | null>(null)
  const [failed, setFailed] = useState(false)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    let alive = true
    setPreview(null)
    setFailed(false)
    setIndex(0)
    void loadDeckPreview(projectId, file)
      .then((loaded) => { if (alive) setPreview(loaded) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [projectId, file])

  const total = preview === null ? 0 : preview.pages.length
  const step = useCallback((delta: number) => {
    setIndex((current) => {
      const next = current + delta
      return next < 0 || next >= total ? current : next
    })
  }, [total])

  // 捕获阶段拦下按键：工作台自己也监听 Esc / 方向键，不 stop 会连带关掉两层。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.stopPropagation()
        event.preventDefault()
        step(-1)
        return
      }
      if (event.key === 'ArrowRight') {
        event.stopPropagation()
        event.preventDefault()
        step(1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [onClose, step])

  const page = total === 0 ? null : preview.pages[Math.min(index, total - 1)]
  const href = meetingDeckUrl(projectId, file)

  return createPortal(
    <div
      className={css.deckPreviewOverlay}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={css.deckPreviewDialog} role="dialog" aria-modal="true" aria-label={t('meetings.preview')}>
        <div className={css.deckPreviewHead}>
          <h3 className={css.deckPreviewTitle} title={file}>{file}</h3>
          {href === '' ? null : <a className={css.btn} href={href} download={file}>{t('meetings.download')}</a>}
          <button type="button" className={css.btn} onClick={onClose}>{t('meetings.previewClose')}</button>
        </div>
        <div className={css.deckPreviewStage}>
          {failed ? (
            <p className={css.failure} role="alert">{t('meetings.previewFailed')}</p>
          ) : preview === null ? (
            <p className={css.hint}>{t('meetings.previewLoading')}</p>
          ) : page === null ? (
            <p className={css.hint}>{t('meetings.previewEmpty')}</p>
          ) : (
            <div className={css.deckSlide} style={{ aspectRatio: String(preview.aspect) }}>
              {page.shapes.map((shape, order) => <DeckShape key={order} shape={shape} />)}
            </div>
          )}
        </div>
        <div className={css.deckPreviewFoot}>
          <button type="button" className={css.btn} disabled={index <= 0} onClick={() => { step(-1) }}>
            {t('meetings.previewPrev')}
          </button>
          <span className={css.deckPreviewPage}>{total === 0 ? '—' : `${index + 1} / ${total}`}</span>
          <button type="button" className={css.btn} disabled={index >= total - 1} onClick={() => { step(1) }}>
            {t('meetings.previewNext')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
