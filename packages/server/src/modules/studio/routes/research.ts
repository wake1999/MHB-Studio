import Router from '@koa/router'

import * as ctrl from '../controllers/research'

export const researchRoutes = new Router()

researchRoutes.get('/api/studio/research/state', ctrl.getState)
researchRoutes.get('/api/studio/research/events', ctrl.events)

researchRoutes.post('/api/studio/research/projects', ctrl.createProject)
researchRoutes.post('/api/studio/research/projects/import', ctrl.importProjectHandler)
researchRoutes.patch('/api/studio/research/projects/:id', ctrl.updateProject)
researchRoutes.delete('/api/studio/research/projects/:id', ctrl.deleteProject)

// arXiv retrieval and subscriptions
researchRoutes.get('/api/studio/research/arxiv/search', ctrl.arxivSearch)
researchRoutes.post('/api/studio/research/projects/:id/papers/import-arxiv', ctrl.importArxivPaper)
researchRoutes.post('/api/studio/research/items/subscriptions/:id/check', ctrl.checkSubscription)

// Paper source, snapshots, compile readiness
researchRoutes.get('/api/studio/research/projects/:id/paper', ctrl.getPaper)
researchRoutes.put('/api/studio/research/projects/:id/paper', ctrl.savePaper)
researchRoutes.get('/api/studio/research/projects/:id/bibliography', ctrl.getBibliography)
researchRoutes.put('/api/studio/research/projects/:id/bibliography', ctrl.saveBibliography)
researchRoutes.post('/api/studio/research/projects/:id/papers/import-bib', ctrl.importPapersToBib)
researchRoutes.get('/api/studio/research/projects/:id/snapshots', ctrl.listSnapshots)
researchRoutes.get('/api/studio/research/projects/:id/snapshots/:snapshotId', ctrl.getSnapshotContent)
researchRoutes.post('/api/studio/research/projects/:id/snapshots', ctrl.createSnapshot)
researchRoutes.post('/api/studio/research/projects/:id/snapshots/:snapshotId/restore', ctrl.restoreSnapshot)
// Seminar deck scaffold (structure from real records, script left to the agent)
researchRoutes.post('/api/studio/research/projects/:id/decks', ctrl.createDeck)
researchRoutes.get('/api/studio/research/projects/:id/decks', ctrl.listDecksHandler)
researchRoutes.get('/api/studio/research/projects/:id/decks/:deckId/file', ctrl.downloadDeck)
// Compiled paper, for the editor's preview pane
researchRoutes.get('/api/studio/research/projects/:id/pdf', ctrl.getPaperPdf)
// One paper's fetched PDF bytes, for the reader's iframe（走 query，旧式 id 带斜杠）
researchRoutes.get('/api/studio/research/paper-pdf', ctrl.getPaperFilePdf)
researchRoutes.get('/api/studio/research/projects/:id/figure', ctrl.getProjectFigure)
researchRoutes.post('/api/studio/research/projects/:id/figures/upload', ctrl.uploadFigureHandler)
researchRoutes.post('/api/studio/research/projects/:id/figures/rename', ctrl.renameFigureHandler)
researchRoutes.post('/api/studio/research/projects/:id/figures/convert', ctrl.convertFigureHandler)
researchRoutes.delete('/api/studio/research/projects/:id/figure', ctrl.deleteFigureHandler)
researchRoutes.get('/api/studio/research/projects/:id/decks/:deckId', ctrl.getDeck)
// Deck preview: the pptx flattened into pages of positioned text/rect shapes.
researchRoutes.get('/api/studio/research/projects/:id/decks/:deckId/preview', ctrl.previewDeck)
researchRoutes.get('/api/studio/research/projects/:id/compile/status', ctrl.compileStatus)
researchRoutes.post('/api/studio/research/projects/:id/compile', ctrl.compileProject)

// Zotero connection probe for the literature view
researchRoutes.get('/api/studio/research/zotero/status', ctrl.zoteroStatus)
researchRoutes.get('/api/studio/research/zotero/collections', ctrl.zoteroCollections)
researchRoutes.get('/api/studio/research/zotero/items', ctrl.zoteroItems)
researchRoutes.post('/api/studio/research/projects/:id/papers/import-zotero', ctrl.importZoteroPaper)
researchRoutes.post('/api/studio/research/projects/:id/bibliography/import-zotero', ctrl.importZoteroCollectionBib)

// Ledger-derived views for the record screen (assembled from stored records)
researchRoutes.get('/api/studio/research/ledger/worktree', ctrl.ledgerWorktree)
researchRoutes.get('/api/studio/research/venue-templates', ctrl.venueTemplatesHandler)
researchRoutes.post('/api/studio/research/moments/pin', ctrl.pinMomentHandler)
researchRoutes.post('/api/studio/research/eureka', ctrl.setEurekaHandler)
researchRoutes.get('/api/studio/research/eureka', ctrl.eurekaView)
researchRoutes.post('/api/studio/research/projects/:id/venue-template', ctrl.applyVenueTemplateHandler)
researchRoutes.delete('/api/studio/research/projects/:id/venue-template', ctrl.clearVenueTemplateHandler)
researchRoutes.post('/api/studio/research/wiki/import', ctrl.importWikiHandler)
researchRoutes.post('/api/studio/research/worktree/mainline', ctrl.setMainlineHandler)
researchRoutes.post('/api/studio/research/worktree/idea-parent', ctrl.setIdeaParentHandler)
researchRoutes.post('/api/studio/research/worktree/adopt', ctrl.adoptIdeaHandler)
researchRoutes.post('/api/studio/research/worktree/close', ctrl.closeIdeaHandler)
researchRoutes.get('/api/studio/research/projects/:id/artifact', ctrl.readArtifactHandler)
researchRoutes.get('/api/studio/research/ledger/foraging', ctrl.ledgerForaging)
researchRoutes.get('/api/studio/research/ledger/moments', ctrl.ledgerMoments)
researchRoutes.get('/api/studio/research/ledger/evidence', ctrl.ledgerEvidence)
researchRoutes.get('/api/studio/research/ledger/digest', ctrl.ledgerDigest)
researchRoutes.get('/api/studio/research/ledger/events', ctrl.ledgerEvents)

// Journal lines, declared evidence edges, paper PDF retrieval
researchRoutes.post('/api/studio/research/journal', ctrl.addJournalEntryHandler)
researchRoutes.post('/api/studio/research/evidence/edges', ctrl.addEvidenceEdgeHandler)
researchRoutes.post('/api/studio/research/evidence/edges/retract', ctrl.retractEvidenceEdgeHandler)
researchRoutes.post('/api/studio/research/projects/:id/papers/fetch-pdf', ctrl.fetchPaperPdfHandler)

// Remote machines and jobs
researchRoutes.post('/api/studio/research/items/servers/:id/check', ctrl.checkServer)
researchRoutes.post('/api/studio/research/items/servers/:id/jobs', ctrl.submitServerJob)
researchRoutes.post('/api/studio/research/items/jobs/:id/refresh', ctrl.refreshJob)

// Panel settings: image generation + web search (SearXNG)
researchRoutes.get('/api/studio/research/settings/image-gen', ctrl.imageGenConfigGet)
researchRoutes.post('/api/studio/research/settings/image-gen', ctrl.imageGenConfigSet)
researchRoutes.get('/api/studio/research/settings/sxng', ctrl.sxngConfigGet)
researchRoutes.post('/api/studio/research/settings/sxng', ctrl.sxngConfigSet)
researchRoutes.get('/api/studio/research/web/search', ctrl.webSearchHandler)

// Conference deadlines (ccfddl)
researchRoutes.get('/api/studio/research/venues/catalog', ctrl.venueCatalog)

researchRoutes.post('/api/studio/research/items/:collection', ctrl.createItem)
researchRoutes.patch('/api/studio/research/items/:collection/:id', ctrl.updateItem)
researchRoutes.delete('/api/studio/research/items/:collection/:id', ctrl.deleteItem)
