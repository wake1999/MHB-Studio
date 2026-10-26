import Router from '@koa/router'
import * as ctrl from '../controllers/chat-apps'

/**
 * 「发现应用」目录：GET 给对话框与提示词模板管理页，写接口只给管理页用。
 */
export const chatAppRoutes = new Router()

chatAppRoutes.get('/api/studio/chat-apps', ctrl.list)
chatAppRoutes.post('/api/studio/chat-apps', ctrl.create)
chatAppRoutes.patch('/api/studio/chat-apps/:id', ctrl.update)
chatAppRoutes.delete('/api/studio/chat-apps/:id', ctrl.remove)
