import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VERSION, handle } from './app'
import { deriveAuthHash, hashPassword, randomSalt } from './password'
import { createTestDatabase } from './testing'
import type { D1Database } from './types'

const BASE = 'https://worklog.example.com'
const USERNAME = 'admin'
const PASSWORD = 'correct-horse-battery'
const ITERATIONS = 1000

interface RecordPayload {
  id: string
  workDate: string
  location: string
  startTime: string
  baseMinutes: number
  overtimeMinutes: number
  timezone: string
}

let db: D1Database
let env: { DB: D1Database }
let authHash: string

interface RequestOptions {
  method?: string
  body?: unknown
  cookie?: string
  origin?: string | null
}

function request(path: string, options: RequestOptions = {}): Request {
  const headers = new Headers()
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  if (options.cookie) headers.set('cookie', options.cookie)
  if (options.origin !== null) headers.set('origin', options.origin ?? BASE)
  return new Request(`${BASE}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
}

function makeRecord(overrides: Partial<RecordPayload> = {}): RecordPayload {
  return {
    id: crypto.randomUUID(),
    workDate: '2026-11-03',
    location: 'art_center',
    startTime: '16:00',
    baseMinutes: 120,
    overtimeMinutes: 0,
    timezone: 'Asia/Shanghai',
    ...overrides
  }
}

async function seedUser(id = 'user-1', username = USERNAME): Promise<void> {
  const salt = randomSalt()
  const hash = await hashPassword(await deriveAuthHash(PASSWORD, username, ITERATIONS), salt)
  await db
    .prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, username, hash, salt, new Date().toISOString())
    .run()
}

async function loginCookie(): Promise<string> {
  const response = await handle(
    request('/auth/login', { method: 'POST', body: { username: USERNAME, authHash } }),
    env
  )
  expect(response.status).toBe(200)
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function submit(cookie: string, operations: unknown[]): Promise<Response> {
  return handle(request('/sync/operations', { method: 'POST', cookie, body: { operations } }), env)
}

beforeEach(async () => {
  db = createTestDatabase()
  env = { DB: db }
  authHash = ''
  await seedUser()
  authHash = await deriveAuthHash(PASSWORD, USERNAME, ITERATIONS)
})

describe('健康检查与会话', () => {
  it('health 不需要登录，也不泄露配置', async () => {
    const response = await handle(request('/health'), env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.version).toBe(VERSION)
    expect(JSON.stringify(body)).not.toMatch(/database|secret|path/i)
  })

  it('业务接口未登录一律 401', async () => {
    for (const path of ['/sync', '/sync/full']) {
      const response = await handle(request(path), env)
      expect(response.status).toBe(401)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('UNAUTHORIZED')
    }
    const operations = await handle(
      request('/sync/operations', { method: 'POST', body: { operations: [] } }),
      env
    )
    expect(operations.status).toBe(401)
  })

  it('登录成功返回 HttpOnly + Secure + SameSite Cookie', async () => {
    const response = await handle(
      request('/auth/login', { method: 'POST', body: { username: USERNAME, authHash } }),
      env
    )
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=2592000')
    expect(cookie).not.toContain(authHash)

    const me = await handle(request('/auth/me', { cookie: (cookie.split(';')[0] ?? '') }), env)
    expect(me.status).toBe(200)
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe(USERNAME)
  })

  it('密码错误返回 401，且不区分用户不存在', async () => {
    const wrongHash = await deriveAuthHash('wrong-password', USERNAME, ITERATIONS)
    const wrong = await handle(
      request('/auth/login', { method: 'POST', body: { username: USERNAME, authHash: wrongHash } }),
      env
    )
    expect(wrong.status).toBe(401)

    const missing = await handle(
      request('/auth/login', { method: 'POST', body: { username: 'nobody', authHash: wrongHash } }),
      env
    )
    expect(missing.status).toBe(401)
    expect((await missing.json()) as unknown).toEqual(await wrong.json())
  })

  it('连续失败 10 次后触发限流', async () => {
    const wrongHash = await deriveAuthHash('wrong-password', USERNAME, ITERATIONS)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handle(
        request('/auth/login', { method: 'POST', body: { username: USERNAME, authHash: wrongHash } }),
        env
      )
      expect(response.status).toBe(401)
    }
    const blocked = await handle(
      request('/auth/login', { method: 'POST', body: { username: USERNAME, authHash } }),
      env
    )
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
  })

  it('跨站来源的写请求被拒绝', async () => {
    const cookie = await loginCookie()
    const response = await handle(
      request('/sync/operations', {
        method: 'POST',
        cookie,
        origin: 'https://evil.example',
        body: { operations: [] }
      }),
      env
    )
    expect(response.status).toBe(403)
  })

  it('退出登录后旧 Cookie 立刻失效', async () => {
    const cookie = await loginCookie()
    const out = await handle(request('/auth/logout', { method: 'POST', cookie, body: {} }), env)
    expect(out.status).toBe(200)
    const after = await handle(request('/sync', { cookie }), env)
    expect(after.status).toBe(401)
  })
})

describe('同步写入与幂等', () => {
  it('创建记录后可以增量拉取', async () => {
    const cookie = await loginCookie()
    const record = makeRecord({ overtimeMinutes: 30 })
    const opId = crypto.randomUUID()

    const response = await submit(cookie, [{ opId, type: 'create', record }])
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      cursor: number
      results: { status: string; revision: number; record: { revision: number } }[]
    }
    expect(body.results[0]?.status).toBe('success')
    expect(body.results[0]?.revision).toBe(1)
    expect(body.cursor).toBe(1)

    const pull = await handle(request('/sync?after=0', { cookie }), env)
    const page = (await pull.json()) as { cursor: number; hasMore: boolean; changes: { seq: number; record: RecordPayload }[] }
    expect(page.changes).toHaveLength(1)
    expect(page.changes[0]?.record.id).toBe(record.id)
    expect(page.changes[0]?.record.overtimeMinutes).toBe(30)
    expect(page.hasMore).toBe(false)
  })

  it('同一个 opId 重试不会产生第二条记录或第二条日志', async () => {
    const cookie = await loginCookie()
    const record = makeRecord()
    const opId = crypto.randomUUID()
    const operation = [{ opId, type: 'create', record }]

    const first = (await (await submit(cookie, operation)).json()) as { results: unknown[] }
    const second = (await (await submit(cookie, operation)).json()) as { results: unknown[] }
    expect(second.results).toEqual(first.results)

    const rows = await db.prepare('SELECT COUNT(*) AS total FROM work_records').first<{ total: number }>()
    expect(rows?.total).toBe(1)
    const logs = await db.prepare('SELECT COUNT(*) AS total FROM change_log').first<{ total: number }>()
    expect(logs?.total).toBe(1)
    const receipts = await db
      .prepare('SELECT COUNT(*) AS total FROM operation_receipts')
      .first<{ total: number }>()
    expect(receipts?.total).toBe(1)
  })

  it('修改成功后 revision 递增，旧 revision 再改会返回冲突且不覆盖数据', async () => {
    const cookie = await loginCookie()
    const record = makeRecord()
    await submit(cookie, [{ opId: crypto.randomUUID(), type: 'create', record }])

    const updated = { ...record, location: 'sutuo', overtimeMinutes: 45 }
    const ok = (await (
      await submit(cookie, [
        { opId: crypto.randomUUID(), type: 'update', recordId: record.id, baseRevision: 1, record: updated }
      ])
    ).json()) as { results: { status: string; revision: number }[] }
    expect(ok.results[0]).toMatchObject({ status: 'success', revision: 2 })

    const stale = (await (
      await submit(cookie, [
        { opId: crypto.randomUUID(), type: 'update', recordId: record.id, baseRevision: 1, record }
      ])
    ).json()) as { results: { status: string; revision: number; record: RecordPayload }[] }
    expect(stale.results[0]?.status).toBe('conflict')
    expect(stale.results[0]?.revision).toBe(2)
    expect(stale.results[0]?.record.location).toBe('sutuo')

    const row = await db
      .prepare('SELECT location, overtime_minutes FROM work_records WHERE id = ?')
      .bind(record.id)
      .first<{ location: string; overtime_minutes: number }>()
    expect(row?.location) .toBe('sutuo')
    expect(row?.overtime_minutes).toBe(45)
  })

  it('删除是逻辑删除，并通过增量同步传播墓碑', async () => {
    const cookie = await loginCookie()
    const record = makeRecord()
    await submit(cookie, [{ opId: crypto.randomUUID(), type: 'create', record }])
    const deleted = await submit(cookie, [
      { opId: crypto.randomUUID(), type: 'delete', recordId: record.id, baseRevision: 1 }
    ])
    expect(await deleted.json()).toMatchObject({ results: [{ status: 'success', revision: 2 }] })

    const pull = await handle(request('/sync?after=1', { cookie }), env)
    const page = (await pull.json()) as { changes: { record: { deletedAt: string | null } }[] }
    expect(page.changes[0]?.record.deletedAt).not.toBeNull()

    const alive = await db
      .prepare('SELECT COUNT(*) AS total FROM work_records WHERE deleted_at IS NULL')
      .first<{ total: number }>()
    expect(alive?.total).toBe(0)
  })

  it('不合法的字段整批拒绝', async () => {
    const cookie = await loginCookie()
    for (const record of [
      makeRecord({ baseMinutes: 100 }),
      makeRecord({ location: 'home' }),
      makeRecord({ overtimeMinutes: -1 }),
      makeRecord({ overtimeMinutes: 721 }),
      makeRecord({ startTime: '25:00' }),
      makeRecord({ workDate: '2026-02-30' })
    ]) {
      const response = await submit(cookie, [{ opId: crypto.randomUUID(), type: 'create', record }])
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('增量拉取分页游标连续', async () => {
    const cookie = await loginCookie()
    const operations = [1, 2, 3].map(index => ({
      opId: crypto.randomUUID(),
      type: 'create',
      record: makeRecord({ workDate: `2026-11-0${index}` })
    }))
    await submit(cookie, operations)

    const first = (await (await handle(request('/sync?after=0&limit=2', { cookie }), env)).json()) as {
      cursor: number
      hasMore: boolean
      changes: { seq: number }[]
    }
    expect(first.changes).toHaveLength(2)
    expect(first.hasMore).toBe(true)

    const second = (await (
      await handle(request(`/sync?after=${first.cursor}&limit=2`, { cookie }), env)
    ).json()) as { cursor: number; hasMore: boolean; changes: { seq: number }[] }
    expect(second.changes).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    expect(second.changes[0]?.seq).toBeGreaterThan(first.cursor)
  })

  it('记录按用户隔离，看不到别人的数据', async () => {
    await seedUser('user-2', 'other')
    await db
      .prepare(
        `INSERT INTO work_records (id, user_id, work_date, location, start_time, base_minutes, overtime_minutes, timezone, created_at, updated_at, revision, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
      )
      .bind(
        crypto.randomUUID(),
        'user-2',
        '2026-11-04',
        'sutuo',
        '10:00',
        120,
        0,
        'Asia/Shanghai',
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run()

    const cookie = await loginCookie()
    const page = (await (await handle(request('/sync?after=0', { cookie }), env)).json()) as {
      changes: unknown[]
    }
    expect(page.changes).toHaveLength(0)

    const full = (await (await handle(request('/sync/full', { cookie }), env)).json()) as {
      records: unknown[]
    }
    expect(full.records).toHaveLength(0)
  })

  it('本地 http 开发时 Cookie 不带 Secure，否则浏览器会直接丢弃', async () => {
    const response = await handle(
      new Request('http://127.0.0.1:8788/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, authHash })
      }),
      env
    )
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Secure')
  })

  it('full 接口返回全部记录与当前游标', async () => {
    const cookie = await loginCookie()
    await submit(cookie, [{ opId: crypto.randomUUID(), type: 'create', record: makeRecord() }])
    const response = await handle(request('/sync/full', { cookie }), env)
    const body = (await response.json()) as { cursor: number; records: RecordPayload[] }
    expect(body.records).toHaveLength(1)
    expect(body.cursor).toBe(1)
  })
})

describe('同步服务诊断', () => {
  it('成功和失败响应均提供请求编号', async () => {
    const health = await handle(request('/health'),env)
    expect(health.headers.get('x-request-id')).toBeTruthy()
    expect(health.headers.get('x-worklog-api')).toBe('sync-diagnostics-1')
    const denied = await handle(request('/sync'),env)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('x-request-id')).toBeTruthy()
    expect(denied.headers.get('x-request-id')).not.toBe(health.headers.get('x-request-id'))
  })
  it('识别缺少迁移的写入错误，日志可按请求编号关联且不记录凭据', async () => {
    const cookie = await loginCookie()
    const logger = vi.spyOn(console,'error').mockImplementation(()=>{})
    try {
      const broken = {...db, prepare(sql:string) {
        if(sql.includes('INSERT INTO work_records')) throw new Error('D1_ERROR: table work_records has no column named record_type')
        return db.prepare(sql)
      }}
      const response = await handle(request('/sync/operations',{method:'POST',cookie,body:{operations:[{opId:crypto.randomUUID(),type:'create',record:makeRecord()}]}}),{DB:broken})
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({error:{code:'DATABASE_SCHEMA_OUTDATED'}})
      expect(logger).toHaveBeenCalledWith('api_request_failed',expect.objectContaining({requestId:response.headers.get('x-request-id'),userId:'user-1',path:'/sync/operations',code:'DATABASE_SCHEMA_OUTDATED'}))
      const logs=JSON.stringify(logger.mock.calls)
      expect(logs).not.toContain(cookie)
      expect(logs).not.toContain(authHash)
      expect(logs).not.toContain(PASSWORD)
    } finally {logger.mockRestore()}
  })
})
