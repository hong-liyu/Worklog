import { login, logout, me, requireUser } from './auth'
import { HttpError, assertSameOrigin, fail, json, readJson } from './http'
import { applyOperations, full, pull } from './records'
import type { Env } from './types'
import { parseLimit, parseOperations, parseRevisionCursor } from './validate'

export const VERSION = '1.1.0'
export const API_REVISION = 'sync-diagnostics-1'
const PREFIX = '/api/v1'

export async function handle(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID()
  const response = await route(request, env, requestId)
  response.headers.set('x-request-id', requestId)
  response.headers.set('x-worklog-api', API_REVISION)
  return response
}

async function route(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(PREFIX)) {
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404)
  }
  const path = url.pathname.slice(PREFIX.length) || '/'
  const method = request.method
  let userId: string | undefined

  try {
    if (method === 'GET' && path === '/health') {
      return json({ ok: true, version: VERSION, apiRevision: API_REVISION, time: new Date().toISOString() })
    }

    if (method === 'POST') assertSameOrigin(request)

    if (method === 'POST' && path === '/auth/login') return await login(env, request)
    if (method === 'POST' && path === '/auth/logout') return await logout(env, request)
    if (method === 'GET' && path === '/auth/me') return await me(env, request)

    const user = await requireUser(env, request)
    userId = user.id

    if (method === 'GET' && path === '/sync') {
      const after = parseRevisionCursor(url.searchParams.get('after'))
      const limit = parseLimit(url.searchParams.get('limit'))
      const page = await pull(env.DB, user.id, after, limit)
      return json(page)
    }

    if (method === 'GET' && path === '/sync/full') {
      return json(await full(env.DB, user.id))
    }

    if (method === 'POST' && path === '/sync/operations') {
      const body = await readJson(request)
      const operations = parseOperations(body.operations)
      const outcome = await applyOperations(env.DB, user.id, operations)
      return json(outcome)
    }

    throw new HttpError(404, 'NOT_FOUND', '接口不存在')
  } catch (error) {
    const internalMessage = error instanceof Error ? error.message : String(error)
    const schemaOutdated = /(?:no (?:such )?column|has no column|CHECK constraint failed)/i.test(internalMessage)
      && /record_type|work_content|base_minutes/i.test(internalMessage)
    const failure = error instanceof HttpError ? error : schemaOutdated
      ? new HttpError(503, 'DATABASE_SCHEMA_OUTDATED', '云端数据库尚未升级，请联系管理员执行数据库迁移')
      : new HttpError(500, 'INTERNAL', '服务器内部错误，请将诊断编号提供给管理员')
    const context = { requestId, cfRay: request.headers.get('cf-ray'), method, path, userId,
      status: failure.status, code: failure.code }
    // Do not log passwords, cookies, request bodies or work content.
    if (error instanceof HttpError) console.warn('api_request_failed', context)
    else console.error('api_request_failed', { ...context, message: internalMessage })
    return fail(failure)
  }
}
