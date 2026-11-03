import { login, logout, me, requireUser } from './auth'
import { HttpError, assertSameOrigin, fail, json, readJson } from './http'
import { applyOperations, full, pull } from './records'
import type { Env } from './types'
import { parseLimit, parseOperations, parseRevisionCursor } from './validate'

export const VERSION = '1.1.0'
const PREFIX = '/api/v1'

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(PREFIX)) {
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404)
  }
  const path = url.pathname.slice(PREFIX.length) || '/'
  const method = request.method

  try {
    if (method === 'GET' && path === '/health') {
      return json({ ok: true, version: VERSION, time: new Date().toISOString() })
    }

    if (method === 'POST') assertSameOrigin(request)

    if (method === 'POST' && path === '/auth/login') return await login(env, request)
    if (method === 'POST' && path === '/auth/logout') return await logout(env, request)
    if (method === 'GET' && path === '/auth/me') return await me(env, request)

    const user = await requireUser(env, request)

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
    if (error instanceof HttpError) return fail(error)
    console.error('未处理的服务端异常', error)
    return json({ error: { code: 'INTERNAL', message: '服务器内部错误' } }, 500)
  }
}
