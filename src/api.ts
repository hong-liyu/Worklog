import { deriveAuthHash } from '../server/password'

const BASE = '/api/v1'
const TIMEOUT_MS = 15_000

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

/**
 * 统一封装：同源、带 Cookie、禁止缓存、15 秒超时。
 * 网络异常向上抛，由调用方区分「保存失败」和「同步失败」。
 */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    return await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    return body.error?.message ?? `请求失败 (${response.status})`
  } catch {
    return `请求失败 (${response.status})`
  }
}

/** 登录：密码在本机派生成 authHash，明文密码不出设备。 */
export async function login(username: string, password: string): Promise<Response> {
  const authHash = await deriveAuthHash(password, username)
  return request('/auth/login', { method: 'POST', body: { username, authHash } })
}

export function logout(): Promise<Response> {
  return request('/auth/logout', { method: 'POST', body: {} })
}
