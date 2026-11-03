import { handle } from '../../server/app'
import type { Env } from '../../server/types'

interface PagesContext {
  request: Request
  env: Env
}

// 所有 /api/* 请求都交给同一套纯函数路由处理（无框架依赖，Worker 与测试共用）。
export const onRequest = (context: PagesContext): Promise<Response> => handle(context.request, context.env)
