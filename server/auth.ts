import { HttpError, clearedCookieHeader, cookieHeader, json, readCookie, readJson, SESSION_COOKIE } from './http'
import { hashPassword, randomSalt, sha256Hex } from './password'
import type { AuthUser, Env } from './types'

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 10

interface UserRow {
  id: string
  username: string
  password_hash: string
  password_salt: string
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

async function countRecentFailures(env: Env, username: string): Promise<number> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString()
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM login_attempts WHERE username = ? AND ok = 0 AND created_at > ?'
  )
    .bind(username, since)
    .first<{ total: number }>()
  return row?.total ?? 0
}

async function recordAttempt(env: Env, request: Request, username: string, ok: boolean): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'local'
  const ipHash = (await sha256Hex(ip)).slice(0, 16)
  const now = new Date().toISOString()
  const statements = [
    env.DB.prepare('INSERT INTO login_attempts (username, ip_hash, ok, created_at) VALUES (?, ?, ?, ?)').bind(
      username,
      ipHash,
      ok ? 1 : 0,
      now
    )
  ]
  if (ok) {
    statements.push(env.DB.prepare('DELETE FROM login_attempts WHERE username = ? AND ok = 0').bind(username))
  }
  await env.DB.batch(statements)
}

export async function login(env: Env, request: Request): Promise<Response> {
  const body = await readJson(request)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const authHash = typeof body.authHash === 'string' ? body.authHash : ''

  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '用户名格式无效')
  }
  if (!/^[A-Za-z0-9+/=_-]{16,128}$/.test(authHash)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '凭据格式无效')
  }
  if ((await countRecentFailures(env, username)) >= MAX_FAILURES) {
    throw new HttpError(429, 'RATE_LIMITED', '尝试过于频繁，请 15 分钟后再试')
  }

  const user = await env.DB.prepare(
    'SELECT id, username, password_hash, password_salt FROM users WHERE username = ?'
  )
    .bind(username)
    .first<UserRow>()

  const expected = user ? await hashPassword(authHash, user.password_salt) : null
  const ok = expected !== null && user !== null && constantTimeEqual(expected, user.password_hash)

  if (!ok || !user) {
    await recordAttempt(env, request, username, false)
    throw new HttpError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
  }

  await recordAttempt(env, request, username, true)

  const token = randomToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString()
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(await sha256Hex(token), user.id, expiresAt, now.toISOString())
    .run()

  return json(
    { user: { username: user.username }, expiresAt },
    200,
    { 'set-cookie': cookieHeader(token, SESSION_TTL_SECONDS, isHttps(request)) }
  )
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE)
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run()
  }
  return json({ ok: true }, 200, { 'set-cookie': clearedCookieHeader(isHttps(request)) })
}

function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

export async function requireUser(env: Env, request: Request): Promise<AuthUser> {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', '请先登录')

  const row = await env.DB.prepare(
    `SELECT s.user_id AS user_id, s.expires_at AS expires_at, u.username AS username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  )
    .bind(await sha256Hex(token))
    .first<{ user_id: string; expires_at: string; username: string }>()

  if (!row) throw new HttpError(401, 'UNAUTHORIZED', '登录状态已失效')
  if (row.expires_at <= new Date().toISOString()) throw new HttpError(401, 'UNAUTHORIZED', '登录状态已过期')

  return { id: row.user_id, username: row.username, expiresAt: row.expires_at }
}

export async function me(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  return json({ user: { username: user.username }, expiresAt: user.expiresAt })
}

/** 供运维脚本使用：生成一条可写入 users 表的记录。 */
export async function buildUserRow(username: string, authHash: string): Promise<UserRow & { created_at: string }> {
  const salt = randomSalt()
  return {
    id: crypto.randomUUID(),
    username,
    password_hash: await hashPassword(authHash, salt),
    password_salt: salt,
    created_at: new Date().toISOString()
  }
}
