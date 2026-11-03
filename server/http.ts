export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } })
}

export function fail(error: HttpError): Response {
  return json({ error: { code: error.code, message: error.message } }, error.status)
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim())
    }
  }
  return null
}

export const SESSION_COOKIE = 'wl_sid'

/**
 * 生产环境（https）始终带 Secure。本地开发走 http://127.0.0.1 时去掉，
 * 否则部分浏览器会直接丢弃 Cookie，导致「登录成功但立刻 401」。
 */
export function cookieHeader(token: string, maxAgeSeconds: number, secure = true): string {
  const flags = `Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAgeSeconds}`
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${flags}`
}

export function clearedCookieHeader(secure = true): string {
  const flags = `Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`
  return `${SESSION_COOKIE}=; ${flags}`
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', '请求内容不是合法 JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '请求内容格式无效')
  }
  return body as Record<string, unknown>
}

/**
 * 同源校验。浏览器发起的跨站 POST 一定带 Origin，且与本站不同，
 * 这里直接拒绝；非浏览器客户端可以不带 Origin。
 */
export function assertSameOrigin(request: Request): void {
  if (request.method === 'GET' || request.method === 'HEAD') return
  const origin = request.headers.get('origin')
  if (!origin) return
  const expected = new URL(request.url).origin
  if (origin !== expected) {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', '请求来源不受信任')
  }
}
