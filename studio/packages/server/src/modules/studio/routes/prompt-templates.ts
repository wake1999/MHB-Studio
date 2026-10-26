import Router from '@koa/router'
import * as ctrl from '../controllers/prompt-templates'

export const promptTemplateRoutes = new Router()

promptTemplateRoutes.get('/api/studio/prompt-templates', ctrl.list)
promptTemplateRoutes.post('/api/studio/prompt-templates', ctrl.create)
promptTemplateRoutes.patch('/api/studio/prompt-templates/:id', ctrl.update)
promptTemplateRoutes.post('/api/studio/prompt-templates/:id/enabled', ctrl.setEnabled)
promptTemplateRoutes.post('/api/studio/prompt-templates/:id/move', ctrl.move)
promptTemplateRoutes.delete('/api/studio/prompt-templates/:id', ctrl.remove)
