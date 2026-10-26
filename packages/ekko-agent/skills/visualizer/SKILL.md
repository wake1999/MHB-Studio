---
name: visualizer
description: "Draw a diagram or an interactive widget directly inside the chat reply instead of writing a file: flowchart, decision tree, architecture or layer map, module relationship, sequence diagram, state machine, data flow, bar/line/donut chart, KPI card, dashboard mock, calculator, toggle panel. 中文触发：流程图、判定树、架构图、分层图、模块关系图、时序图、状态机、数据流图、柱状图、折线图、环形图、示意图、可视化、小部件、交互原型。"
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  keywords:
    - visualizer
    - diagram
    - inline svg
    - inline html
    - flowchart
    - architecture diagram
    - sequence diagram
    - interactive widget
---

# Visualizer

This skill covers the chat-native visual contract. The chat renders an `svg` or
`html` fence in place, so a diagram appears inside the answer while it streams.
Nothing is written to disk and no image model is involved.

## Contract

- One fence per visual, at most six per message, at most 200 KB each.
- `svg` is inlined after sanitizing: `script`, `foreignObject`, `iframe`,
  `object`, `embed`, `audio`, `video`, `canvas`, `on*` handlers, `javascript:`
  URLs and `@import` are removed. Anything stripped takes the picture with it.
- `html` runs in a sandboxed iframe: scripts and forms work, same-origin access
  to the host page does not, and no network requests are allowed.
- The reply's prose stays outside the fence. Never wrap the whole answer in a
  visual block, and never write `.svg`/`.html` files for a chat answer.

## Pick the shape

| The user wants | Fence |
| --- | --- |
| Flow, decision tree, architecture, layers, module map, state machine, sequence, data flow | `svg` |
| Data chart (bar / line / donut / progress) | `svg` with primitives |
| Something clickable: toggles, tabs, sliders, mini calculator, KPI dashboard | `html` |

A comparison of many items across fields is a Markdown table, not a figure — columns
never line up inside an SVG and nothing in it can be copied. The same goes for
parameters, options, or config described one by one.

Prefer `svg`. Reach for `html` only when the visual needs state or interaction.

## SVG rules

- Root element: `<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="…">`
  and design for a 640 px wide frame; height between 160 and 420.
- Theme-safe colors only: `fill="currentColor"` with `fill-opacity` 0.04–0.12
  for surfaces, `stroke-opacity` 0.35–0.6 for lines. Never hard-code white
  backgrounds or black text; the reply may be dark.
- Text: `font-family="system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif"`,
  `font-size` 14–16, `text-anchor="middle"` for centered labels, and keep each
  node label short (2–6 characters). Label in the user's language.
- One `<marker>` arrowhead in `<defs>`, reused with `marker-end="url(#arrow)"`.
- Keep 24–40 px outer margins so nothing touches the rounded frame.
- No `foreignObject`, no HTML tags, no external images or fonts.

## HTML rules

- Emit the document body only: markup first, `<style>` in the head area, a
  `<script>` at the end. One file, no imports, no frameworks.
- Fluid layout: `body { margin: 0 }`, widths in `%`/`min()`; never `100vh`,
  `position: fixed`, or a fixed width wider than 700 px.
- Theme support: declare `color-scheme: light dark`, style both
  `@media (prefers-color-scheme: dark)` and `html[data-theme="dark"]` (the host
  sets that attribute when the app itself is dark), and avoid pure `#fff`
  surfaces. Use `currentColor` for text and neutral borders like
  `rgba(127,127,127,.35)`.
- No `fetch`, `XMLHttpRequest`, `WebSocket`, external images, or CDN links.
  Inline SVG icons instead of emoji fonts.
- Controls are real `<button type="button">` elements with hover/active states
  and a visible result for every action.
- Keep it under 200 KB; a widget that needs a build step is a widget the chat
  cannot draw.

## Skeletons

Flowchart (swap the labels, keep the structure):

```svg
<svg viewBox="0 0 640 200" width="100%" role="img" aria-label="流程图">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 Z" fill="currentColor" fill-opacity="0.6"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, 'Segoe UI', 'Noto Sans SC', sans-serif">
    <rect x="110" y="62" width="180" height="76" rx="8" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="200" y="107" text-anchor="middle" font-size="15" font-weight="600">第一步</text>
    <line x1="290" y1="100" x2="350" y2="100" stroke="currentColor" stroke-opacity="0.6" marker-end="url(#arrow)"/>
    <rect x="350" y="62" width="180" height="76" rx="8" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="440" y="107" text-anchor="middle" font-size="15" font-weight="600">第二步</text>
  </g>
</svg>
```

Interactive widget (three-part state, no library):

```html
<div class="card">
  <h3>标题</h3>
  <div class="row"><span>指标</span><strong>8,200</strong></div>
  <button type="button" id="go">标记完成</button>
</div>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, 'Noto Sans SC', sans-serif; color: #1f2328; }
  .card { padding: 16px; border: 1px solid rgba(127,127,127,.35); border-radius: 12px; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; }
  button { width: 100%; padding: 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
  body.done .card { border-color: #16a34a; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; } }
  html[data-theme="dark"] body { color: #e6edf3; }
</style>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.body.classList.toggle('done')
    document.getElementById('go').textContent = '已完成'
  })
</script>
```

## Checklist before sending

- Exactly one fence, correctly closed (`</svg>`, `</script>`).
- Labels in the user's language; no filler sentences inside the picture.
- Renders at 640 px without overflow or clipped text.
- Readable in both themes: no fixed light-only or dark-only colors.
- Every interactive control changes something visible.

## Anti-patterns

- Mermaid, PlantUML, Canvas, chart.js, D3: the chat renders none of them.
- Pasting a diagram's source code as prose, or printing it as a normal code block.
- Emoji-heavy pseudo-diagrams when a real SVG takes the same effort.
- `foreignObject` for layout (stripped), or HTML nested inside an `svg` fence.
