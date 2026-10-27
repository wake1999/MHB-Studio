// @ts-nocheck 鈥?vendored ui-mimir island: React 18 JSX plus dsh-* SDK modules that exist only as ambient stubs here, so project-wide type checking cannot cover it. Transformed by esbuild with jsxImportSource=react and verified at runtime.
/**
 * React 岛入口：把上游 `ResearchPanel` 原样挂到 ekko 的一个 DOM 容器里。
 *
 * 上游这一层本来由 dsh 的 slot 系统注入（`ctx.slots.register({ store, locale, inject })`），
 * 面板收到的 props 就是「共享 store + 注入的回调 + 文案」。这里不引 dsh 运行时，
 * 而是自己造出同样四件东西：
 *   1. `useStore` —— store 句柄 + 选择器（useSyncExternalStore）；
 *   2. `actions`  —— store 的动作表；
 *   3. `hooks`    —— research（控制器）/ chrome（深浅色+语言）/ sessionList；
 *   4. `t`        —— 用上游 locales.ts 的 zh/en 词典做插值。
 * 回调表按上游 index.ts 的 inject 段逐一对应，指向同一个控制器。
 */

import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ResearchPanel } from './ResearchPanel.tsx'
import { uploadResearchFigure } from '@/api/studio/research'
import { ResearchController } from './controller.ts'
import { createResearchPanelStore } from './store.ts'
import { en, zh, type ResearchKey } from './locales.ts'
import { createMimirRemote } from './remote-adapter.ts'
import { fetchSessions } from '@/api/studio/sessions'
import { fetchResearchPdf } from '@/api/studio/research'
import { useChatStore } from '@/stores/hermes/chat'

type Locale = 'zh' | 'en'

interface ChromeState {
  readonly dark: boolean
  readonly locale: Locale
}

const DARK_KEY = 'hermes_brightness'

function readDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function makeT(getLocale: () => Locale) {
  return (key: string, params?: Record<string, unknown>): string => {
    const dict = getLocale() === 'en' ? (en as Record<string, string>) : (zh as Record<string, string>)
    const raw = dict[key] ?? key
    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name]
      return value === undefined ? match : String(value)
    })
  }
}

export interface MimirWorkbench {
  unmount: () => void
}

/** Mount the upstream workbench into one container element. */
export function createMimirWorkbench(container: HTMLElement): MimirWorkbench {
  const panel = createResearchPanelStore()
  // 岛就是工作台本身：进页面即展开。面板把 open=false 当成「卸载」，嵌成页面后
  // 一收起就是白屏，所以关闭动作在这里吞掉（× 按钮也由 mimir-embed.css 隐藏）。
  const setPanelOpen = panel.actions.setOpen
  panel.actions.setOpen = () => { setPanelOpen(true) }
  panel.actions.setOpen(true)
  const controller = new ResearchController(createMimirRemote() as never)

  /**
   * 总览的统计卡与「最近动态」读的是别的页签已经拉过的切片；上游在浮层里靠用户
   * 逐个点开加载，嵌成页面后不点就永远是「—」。项目列表一到位就先预取一轮，
   * 之后照旧由各视图自己刷新。
   */
  let prefetched = false
  const prefetch = (): void => {
    if (prefetched) return
    const view = controller.getSnapshot() as {
      projects?: readonly unknown[]
      selectedProjectId?: string | null
    }
    if (!view.projects?.length) return
    prefetched = true
    controller.ensurePapers()
    controller.ensureServers()
    controller.ensureJobs()
    controller.ensureSubscriptions()
    const projectId = view.selectedProjectId ?? null
    controller.ensureVenues(projectId)
    if (projectId !== null) controller.loadFigures(projectId)
  }
  const unsubscribePrefetch = controller.subscribe(prefetch)

  /* chrome：深浅色跟 html.dark 走，语言在面板内单独维护 */
  let chrome: ChromeState = Object.freeze({ dark: readDark(), locale: 'zh' as Locale })
  const chromeListeners = new Set<() => void>()
  const emitChrome = (next: ChromeState): void => {
    if (next.dark === chrome.dark && next.locale === chrome.locale) return
    chrome = Object.freeze(next)
    for (const listener of [...chromeListeners]) listener()
  }
  const themeObserver = new MutationObserver(() => { emitChrome({ ...chrome, dark: readDark() }) })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

  /* sessions：上游的「当前会话」是整条客户端的全局选择，面板里所有「… 用 AI」
     动词都投递到它。ekko 侧会话由 /api/studio/sessions 提供，这里读列表、记住
     用户的选择；之前写死空列表，下拉永远是「未选择会话」。 */
  interface WorkbenchSession { readonly id: string; readonly title: string }
  const SESSION_KEY = 'mimir.session.current'
  let sessionSnapshot = Object.freeze({
    current: null as string | null,
    list: [] as readonly WorkbenchSession[],
  })
  const sessionListeners = new Set<() => void>()
  const emitSessions = (next: typeof sessionSnapshot): void => {
    sessionSnapshot = Object.freeze(next)
    for (const listener of [...sessionListeners]) listener()
  }
  const loadSessions = async (): Promise<void> => {
    try {
      const rows = await fetchSessions(undefined, 50)
      const list = rows
        .filter(row => typeof row.id === 'string' && row.id.length > 0)
        .map(row => ({ id: row.id, title: (row.title || row.preview || row.id).slice(0, 80) }))
      const saved = localStorage.getItem(SESSION_KEY)
      const current = saved !== null && list.some(item => item.id === saved)
        ? saved
        : (list.length > 0 ? list[0].id : null)
      if (current !== null && current !== saved) localStorage.setItem(SESSION_KEY, current)
      emitSessions({ current, list })
    } catch {
      emitSessions({ current: null, list: [] })
    }
  }

  void loadSessions()

  /* PDF 预览：ekko 的 PDF 在 /api 下要 Bearer 头，iframe 带不上；这里取成 blob URL
     后交给 PaperView。按「项目 + 编译时间」缓存，最多留 3 份。 */
  const pdfBlobCache = new Map<string, string>()
  const resolvePdfUrl = async (projectId: string, updatedAt: number): Promise<string | null> => {
    const key = `${projectId}@${updatedAt}`
    const cached = pdfBlobCache.get(key)
    if (cached !== undefined) return cached
    try {
      const blob = await fetchResearchPdf(projectId)
      const url = URL.createObjectURL(blob)
      pdfBlobCache.set(key, url)
      while (pdfBlobCache.size > 3) {
        const oldest = pdfBlobCache.keys().next().value as string | undefined
        if (oldest === undefined) break
        const dead = pdfBlobCache.get(oldest)
        if (dead !== undefined) URL.revokeObjectURL(dead)
        pdfBlobCache.delete(oldest)
      }
      return url
    } catch {
      return null
    }
  }

  const t = makeT(() => chrome.locale)

  /* hooks：把三个 observable 包成面板要的 useX(selector) 形态 */
  const useStore = (selector: (state: any) => any): any =>
    useSyncExternalStore(panel.subscribe, () => selector(panel.getSnapshot()))

  const useResearch = (selector: (view: any) => any): any =>
    useSyncExternalStore(controller.subscribe, () => selector(controller.getSnapshot()))

  const useChrome = (selector: (state: ChromeState) => any): any =>
    useSyncExternalStore(
      (listener: () => void) => {
        chromeListeners.add(listener)
        return () => { chromeListeners.delete(listener) }
      },
      () => selector(chrome),
    )

  const useSessionList = (selector: (state: typeof sessionSnapshot) => any): any =>
    useSyncExternalStore(
      (listener: () => void) => {
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
      () => selector(sessionSnapshot),
    )

  const actions = panel.actions as Record<string, (...args: never[]) => void>

  /**
   * 面板里所有「…with AI」都投递到面板选中的会话：提示词由各视图拼好，
   * 这里只切会话、真正发出去，并按流程回一条成功/失败提示。
   */
  interface SendCopy { readonly sent: ResearchKey; readonly failed: ResearchKey }

  const SEND_COPY: Record<'fix' | 'relwork' | 'figureOrganize' | 'venueFormat', SendCopy> = {
    fix: { sent: 'toast.fixSent', failed: 'toast.fixSendFailed' },
    relwork: { sent: 'toast.relworkSent', failed: 'toast.relworkSendFailed' },
    figureOrganize: { sent: 'toast.figureOrganizeSent', failed: 'toast.figureOrganizeSendFailed' },
    venueFormat: { sent: 'toast.venueFormatSent', failed: 'toast.venueFormatSendFailed' },
  }

  const sendPromptToCurrentSession = async (prompt: string, copy: SendCopy): Promise<void> => {
    const sessionId = sessionSnapshot.current
    if (sessionId === null) {
      controller.notify('error', copy.failed, t('toast.fixNoSession'))
      return
    }
    try {
      const chat = useChatStore()
      /* 面板选的会话可能还没进 chat store（列表未加载 / 换了 profile），先拉一次并顺带切过去 */
      if (!chat.sessions.some(item => item.id === sessionId)) {
        await chat.loadSessions(undefined, sessionId)
      }
      if (!chat.sessions.some(item => item.id === sessionId)) {
        controller.notify('error', copy.failed, t('toast.fixNoSession'))
        return
      }
      if (chat.activeSessionId !== sessionId) await chat.switchSession(sessionId)
      /* 会话不在列表时 switchSession 只改 id、不落 activeSession；此时再 send 会另起一个新会话 */
      if (chat.activeSessionId !== sessionId || chat.activeSession === null) {
        controller.notify('error', copy.failed, t('toast.fixNoSession'))
        return
      }
      await chat.sendMessage(prompt)
      /* sendMessage 不抛出：失败会写一条 system 消息进对话，这里回读一次 */
      const messages = chat.sessions.find(item => item.id === sessionId)?.messages
      const last = messages?.[messages.length - 1]
      const failed = last?.role === 'system' && typeof last.content === 'string'
        && last.content.startsWith('Error:')
      if (failed) {
        const detail = (last.content as string).slice('Error:'.length).trim()
        controller.notify('error', copy.failed, detail || null)
        return
      }
      controller.notify('success', copy.sent)
    } catch (error) {
      controller.notify('error', copy.failed, error instanceof Error ? error.message : null)
    }
  }

  const props: Record<string, unknown> = {
    useStore,
    actions,
    hooks: { research: controller, chrome: { getSnapshot: () => chrome, subscribe: (l: () => void) => {
      chromeListeners.add(l)
      return () => { chromeListeners.delete(l) }
    } }, sessionList: { getSnapshot: () => sessionSnapshot, subscribe: (l: () => void) => {
      sessionListeners.add(l)
      return () => { sessionListeners.delete(l) }
    } } },
    useResearch,
    useChrome,
    useSessionList,
    t,

    toggleTheme: () => {
      const next = !readDark()
      document.documentElement.classList.toggle('dark', next)
      try { localStorage.setItem(DARK_KEY, next ? 'dark' : 'light') } catch { /* private mode */ }
      emitChrome({ ...chrome, dark: next })
    },
    toggleLocale: () => { emitChrome({ ...chrome, locale: chrome.locale === 'en' ? 'zh' : 'en' }) },

    ensure: () => { controller.ensure() },
    selectProject: (projectId: string | null) => {
      actions.select(projectId)
      controller.select(projectId)
    },
    importProject: async (path: string, title: string) => {
      const outcome = await controller.importProject(path, title)
      if ('code' in outcome) return outcome
      actions.select(outcome.projectId)
      controller.select(outcome.projectId)
      return outcome
    },
    createProject: async (title: string) => {
      const outcome = await controller.createProject(title)
      if ('code' in outcome) return outcome
      actions.select(outcome.id)
      controller.select(outcome.id)
      return outcome
    },
    renameProject: (projectId: string, title: string) => controller.renameProject(projectId, title),
    deleteProject: (projectId: string) => controller.deleteProject(projectId),
    selectSession: (sessionId: string) => {
      if (!sessionSnapshot.list.some(item => item.id === sessionId)) return
      localStorage.setItem(SESSION_KEY, sessionId)
      emitSessions({ ...sessionSnapshot, current: sessionId })
    },
    compile: (projectId: string) => { void controller.compile(projectId) },
    resolvePdfUrl,

    requestCompileFix: (prompt: string) => sendPromptToCurrentSession(prompt, SEND_COPY.fix),
    requestRelatedWork: (prompt: string) => sendPromptToCurrentSession(prompt, SEND_COPY.relwork),
    requestFigureOrganize: (prompt: string) => sendPromptToCurrentSession(prompt, SEND_COPY.figureOrganize),
    requestVenueFormat: (prompt: string) => sendPromptToCurrentSession(prompt, SEND_COPY.venueFormat),

    ensureVenueTemplates: () => { controller.ensureVenueTemplates() },
    applyVenueTemplate: (projectId: string, options: unknown) => controller.applyVenueTemplate(projectId, options as never),
    clearVenueTemplate: (projectId: string) => controller.clearVenueTemplate(projectId),
    ensureVenues: (projectId: string) => { controller.ensureVenues(projectId) },
    refreshVenues: (projectId: string) => { controller.refreshVenues(projectId) },
    refreshVenueCatalog: (projectId: string) => controller.refreshVenueCatalog(projectId),
    toggleVenueWatch: (seriesKey: string) => controller.toggleVenueWatch(seriesKey),
    uploadTemplateFiles: async () => { controller.notify('error', 'toast.templateUploaded') },

    editSource: (content: string) => { controller.edit(content) },
    reloadSource: () => { controller.reloadSource() },
    ensurePapers: () => { controller.ensurePapers() },
    ensureSubscriptions: () => { controller.ensureSubscriptions() },
    saveArxivSubscription: (query: string) => controller.saveArxivSubscription(query),
    deleteArxivSubscription: (id: string) => controller.deleteArxivSubscription(id),
    checkArxivSubscriptions: () => controller.checkArxivSubscriptions(),
    searchArxiv: (query: string) => { controller.searchArxiv(query) },
    searchWeb: (query: string) => { controller.searchWeb(query) },
    importPaper: (entry: unknown, projectId?: string) => controller.importPaper(entry as never, projectId),
    removePaper: (arxivId: string) => controller.removePaper(arxivId),
    updatePaper: (arxivId: string, patch: unknown) => controller.updatePaper(arxivId, patch as never),
    fetchPaperPdf: (arxivId: string) => controller.fetchPaperPdf(arxivId),

    ensureZotero: () => { controller.ensureZotero() },
    recheckZotero: () => { controller.recheckZotero() },
    searchZotero: (query: string) => { controller.searchZotero(query) },
    importZoteroItem: (key: string, projectId?: string) => controller.importZoteroItem(key, projectId),
    exportZoteroCollectionToBib: (projectId: string, collectionKey: string) =>
      controller.exportZoteroCollectionToBib(projectId, collectionKey),

    loadArtifact: (projectId: string, name: string) => { controller.loadArtifact(projectId, name) },
    loadFigures: (projectId: string, force?: boolean, quiet?: boolean) => { controller.loadFigures(projectId, force, quiet) },
    uploadFigures: async (
      projectId: string,
      dir: string | undefined,
      files: readonly File[],
      onProgress?: (done: number, total: number) => void,
    ) => {
      let done = 0
      for (const file of files) {
        await uploadResearchFigure(projectId, file, dir)
        done += 1
        onProgress?.(done, files.length)
      }
      controller.loadFigures(projectId, true)
      if (done > 0) controller.notify('success', 'toast.figuresUploaded', `× ${done}`)
    },
    deleteFigure: (projectId: string, relPath: string) => controller.deleteFigure(projectId, relPath),
    loadMeetings: (projectId: string, force?: boolean) => { controller.loadMeetings(projectId, force) },
    generateMeetingDeck: (projectId: string, request: unknown) => controller.generateMeetingDeck(projectId, request as never),
    deleteMeetingDeck: (projectId: string, file: string) => controller.deleteMeetingDeck(projectId, file),
    getImageGenConfig: () => { controller.getImageGenConfig() },
    saveImageGenConfig: (input: unknown) => controller.saveImageGenConfig(input as never),
    getSxngConfig: () => { controller.getSxngConfig() },
    saveSxngConfig: (input: unknown) => controller.saveSxngConfig(input as never),
    renameFigure: (projectId: string, relPath: string, newName: string) => controller.renameFigure(projectId, relPath, newName),
    updateFigure: (projectId: string, relPath: string, caption: string) => controller.updateFigure(projectId, relPath, caption),
    insertFigure: async (projectId: string, entry: unknown) => {
      const line = await controller.insertFigureIntoPaper(projectId, entry as never)
      if (line !== null) actions.setTab('paper')
    },
    generateMetricFigure: async (projectId: string, metricKey: string, rows: unknown, direction: unknown) => {
      const line = await controller.generateMetricFigure(projectId, metricKey, rows as never, direction as never)
      if (line !== null) actions.setTab('paper')
    },
    consumePaperJump: () => { controller.consumePaperJump() },

    deleteExperiment: (id: string) => controller.deleteExperiment(id),
    updateExperiment: (id: string, serverId: string) => controller.updateExperiment(id, serverId),
    saveExperiment: (experiment: unknown) => controller.saveExperiment(experiment as never),
    ensureServers: () => { controller.ensureServers() },
    saveServer: (server: unknown) => controller.saveServer(server as never),
    deleteServer: (id: string) => controller.deleteServer(id),
    checkServer: (id: string) => controller.checkServer(id),
    checkAllServers: () => { void controller.checkAllServers() },
    ensureJobs: () => { controller.ensureJobs() },
    refreshJobs: () => { controller.refreshJobs() },
    submitJob: (serverId: string, command: string, experimentId?: string) => controller.submitJob(serverId, command, experimentId),
    deleteJob: (id: string) => controller.deleteJob(id),

    ensureBibliography: (projectId: string) => { controller.ensureBibliography(projectId) },
    reloadBibliography: () => { controller.reloadBibliography() },
    deleteBibEntry: (key: string) => controller.deleteBibEntry(key),
    updateBibEntry: (originalKey: string, entry: unknown) => controller.updateBibEntry(originalKey, entry as never),
    importPapersToBib: (projectId: string, arxivIds: readonly string[]) => controller.importPapersToBib(projectId, arxivIds),

    loadSnapshots: (projectId: string, force?: boolean) => { controller.loadSnapshots(projectId, force) },
    loadSnapshotDetail: (projectId: string, id: string) => { controller.loadSnapshotDetail(projectId, id) },
    closeSnapshotDetail: () => { controller.closeSnapshotDetail() },
    revertSnapshot: (projectId: string, id: string) => controller.revertSnapshot(projectId, id),
    reorderPaperSections: (projectId: string, moves: unknown, baseOutline: unknown) =>
      controller.reorderPaperSections(projectId, moves as never, baseOutline as never),
    reorderPaperSubsections: (projectId: string, moves: unknown, baseOutline: unknown) =>
      controller.reorderPaperSubsections(projectId, moves as never, baseOutline as never),

    loadLedger: (filter: unknown) => { controller.loadLedger(filter as never) },
    generateReport: (options: unknown) => controller.generateReport(options as never),
    generateBrief: (options: unknown) => controller.generateBrief(options as never),
    addJournal: (text: string, projectId?: string, refs?: unknown) => controller.addJournal(text, projectId, refs as never),

    ensureWorktree: () => { controller.ensureWorktree() },
    refreshWorktree: () => { controller.refreshWorktree() },
    setMainline: (lineId: string) => controller.setMainline(lineId),
    setIdeaParent: (ideaId: string, parentIdeaId: string | null) => controller.setIdeaParent(ideaId, parentIdeaId),
    adoptIdea: (ideaId: string) => controller.adoptIdea(ideaId),
    closeIdea: (ideaId: string, reason: string) => controller.closeIdea(ideaId, reason),
    ensureForaging: () => { controller.ensureForaging() },
    refreshForaging: () => { controller.refreshForaging() },
    ensureMoments: () => { controller.ensureMoments() },
    refreshMoments: () => { void controller.refreshMoments() },
    declineMoment: (targetEventId: string) => controller.declineMoment(targetEventId),
    loadEvidenceGraph: (request: unknown) => { controller.loadEvidenceGraph(request as never) },
    refreshEvidenceGraph: () => { controller.refreshEvidenceGraph() },
    retractEvidence: (dedupKey: string, reason: string) => controller.retractEvidence(dedupKey, reason),
    ensureDigest: () => { controller.ensureDigest() },
    refreshDigest: () => { controller.refreshDigest() },
    ensureEureka: () => { controller.ensureEureka() },
    generateDigest: (tier: string, lang: string) => controller.generateDigest(tier as never, lang as never),
    setEureka: (ideaId: string, projectId: string, title: string) => controller.setEureka(ideaId, projectId, title),
    pinMoment: (targetEventId: string, note?: string) => controller.pinMoment(targetEventId, note),

    exportWiki: () => controller.exportWiki(),
    importWiki: (snapshot: unknown, mode: unknown, confirmReplace: boolean) =>
      controller.importWiki(snapshot as never, mode as never, confirmReplace),

    dismissToast: (id: string) => { controller.dismissToast(id) },
    pruneToasts: () => { controller.pruneToasts() },
  }

  const root = createRoot(container)
  root.render(createElement(ResearchPanel as never, props as never))

  return {
    unmount: () => {
      themeObserver.disconnect()
      unsubscribePrefetch()
      controller.dispose()
      root.unmount()
    },
  }
}
