import Router from '@koa/router'
import * as ctrl from '../controllers/skills'
import * as marketCtrl from '../controllers/skills-market'

export const skillRoutes = new Router()

skillRoutes.get('/api/hermes/skills', ctrl.list)
skillRoutes.get('/api/hermes/skills/usage/stats', ctrl.usageStats)
skillRoutes.get('/api/hermes/skills/external-dirs', ctrl.listExternalDirs)
skillRoutes.put('/api/hermes/skills/external-dirs', ctrl.updateExternalDirs)
skillRoutes.get('/api/hermes/skills/categories', ctrl.listCategories)
skillRoutes.post('/api/hermes/skills/categories', ctrl.createCategory)
// Must precede `/skills/:category/:skill`, which would otherwise swallow it.
skillRoutes.delete('/api/hermes/skills/categories/:category', ctrl.deleteCategory)
skillRoutes.put('/api/hermes/skills/toggle', ctrl.toggle)
skillRoutes.put('/api/hermes/skills/toggle-batch', ctrl.toggleBatch)
skillRoutes.put('/api/hermes/skills/pin', ctrl.pin_)
skillRoutes.post('/api/hermes/skills/import', ctrl.importSkill)
skillRoutes.get('/api/hermes/skills-market/search', marketCtrl.search)
skillRoutes.post('/api/hermes/skills-market/install', marketCtrl.install)
skillRoutes.put('/api/hermes/skills/:category/:skill', ctrl.updateSkill)
skillRoutes.delete('/api/hermes/skills/:category/:skill', ctrl.deleteSkill)
skillRoutes.get('/api/hermes/skills/:category/:skill/files', ctrl.listFiles)
skillRoutes.get('/api/hermes/skills/{*path}', ctrl.readFile_)
