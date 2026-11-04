import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordInput, WorkRecord } from './domain'
import { allRecords, db, pendingOps, saveRecord } from './storage'
import { syncDiagnosticReport } from './diagnostics'
import { syncNow } from './sync'

const input: RecordInput = {
  workDate: '2026-11-03',
  location: 'art_center',
  startTime: '16:00',
  baseMinutes: 120,
  overtimeMinutes: 0,
  timezone: 'Asia/Shanghai'
}

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>

function stubFetch(handler: FetchMock): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((target: RequestInfo | URL, init?: RequestInit) => handler(String(target), init))
  )
}

function opIds(init?: RequestInit): string[] {
  if (!init?.body) return []
  const body = JSON.parse(String(init.body)) as { operations: { opId: string }[] }
  return body.operations.map(operation => operation.opId)
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('同步流程', () => {
  it('推送成功后清空队列，状态变为已同步', async () => {
    const record = await saveRecord(input)
    const wire: WorkRecord = { ...record, revision: 1, updatedAt: new Date().toISOString() }

    stubFetch(async (url, init) => {
      if (url.includes('/sync/operations')) {
        const [opId] = opIds(init)
        return Response.json({
          cursor: 1,
          results: [{ opId, status: 'success', revision: 1, record: wire }]
        })
      }
      return Response.json({ cursor: 1, hasMore: false, changes: [] })
    })

    const state = await syncNow()
    expect(state).toEqual({ phase: 'synced', pending: 0 })
    expect(await pendingOps()).toHaveLength(0)
    const [stored] = await allRecords()
    expect(stored).toMatchObject({ revision: 1, dirty: 0 })
  })

  it('版本冲突时换成服务器 revision 重投，最终报告冲突而不是静默覆盖', async () => {
    const record = await saveRecord(input)
    const serverRecord: WorkRecord = { ...record, revision: 5, location: 'sutuo' }

    stubFetch(async (url, init) => {
      if (url.includes('/sync/operations')) {
        return Response.json({
          cursor: 0,
          results: [{ opId: opIds(init)[0], status: 'conflict', revision: 5, record: serverRecord }]
        })
      }
      return Response.json({ cursor: 0, hasMore: false, changes: [] })
    })

    const state = await syncNow()
    expect(state.phase).toBe('conflict')
    const ops = await pendingOps()
    expect(ops).toHaveLength(1)
    expect(ops[0]?.baseRevision).toBe(5)
    // 本机内容没有被服务器版本静默覆盖
    const [stored] = await allRecords()
    expect(stored?.location).toBe('art_center')
  })

  it('拉取到远端变更后写入本地并推进游标', async () => {
    const remote: WorkRecord = {
      recordType: 'duty', workContent: null,
      id: crypto.randomUUID(),
      workDate: '2026-11-06',
      location: 'sutuo',
      startTime: '18:00',
      baseMinutes: 180,
      overtimeMinutes: 60,
      timezone: 'Asia/Shanghai',
      createdAt: '2026-11-06T10:00:00.000Z',
      updatedAt: '2026-11-06T10:00:00.000Z',
      revision: 1,
      deletedAt: null
    }

    stubFetch(async url => {
      if (url.includes('/sync/operations')) return Response.json({ cursor: 0, results: [] })
      return Response.json({ cursor: 4, hasMore: false, changes: [{ seq: 4, record: remote }] })
    })

    const state = await syncNow()
    expect(state.phase).toBe('synced')

    const [stored] = await allRecords()
    expect(stored?.id).toBe(remote.id)
    expect(stored?.baseMinutes).toBe(180)
    expect(stored?.dirty).toBe(0)
    expect(await db.meta.get('syncCursor')).toMatchObject({ value: 4 })
  })

  it('登录失效时返回 unauthorized，不清空本地数据', async () => {
    await saveRecord(input)
    stubFetch(async () => new Response(null, { status: 401 }))

    const state = await syncNow()
    expect(state.phase).toBe('unauthorized')
    expect(await allRecords()).toHaveLength(1)
  })

  it('网络异常时保留队列并报告失败', async () => {
    await saveRecord(input)
    stubFetch(async () => {
      throw new Error('network down')
    })

    const state = await syncNow()
    expect(state.phase).toBe('failed')
    expect(await pendingOps()).toHaveLength(1)
  })

  it('离线攒下的操作会拆成多个小批次，避免撞上 Workers 的子请求上限', async () => {
    for (let index = 1; index <= 15; index += 1) {
      await saveRecord({ ...input, workDate: `2026-11-${String(index).padStart(2, '0')}` })
    }

    const batchSizes: number[] = []
    stubFetch(async (url, init) => {
      if (!url.includes('/sync/operations')) {
        return Response.json({ cursor: 0, hasMore: false, changes: [] })
      }
      const body = JSON.parse(String(init?.body)) as {
        operations: { opId: string; record: Record<string, unknown> }[]
      }
      batchSizes.push(body.operations.length)
      return Response.json({
        cursor: 1,
        results: body.operations.map(operation => ({
          opId: operation.opId,
          status: 'success',
          revision: 1,
          record: {
            ...operation.record,
            createdAt: '2026-11-03T00:00:00.000Z',
            updatedAt: '2026-11-03T00:00:00.000Z',
            revision: 1,
            deletedAt: null
          }
        }))
      })
    })

    const state = await syncNow()
    expect(state.phase).toBe('synced')
    expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(15)
    expect(batchSizes.every(size => size <= 6)).toBe(true)
    expect(batchSizes.length).toBeGreaterThanOrEqual(3)
    expect(await pendingOps()).toHaveLength(0)
  })
})

describe('同步诊断与失败数据保留', () => {
  it.each([400,403,500,503])('HTTP %i 保存上传环节和请求编号，保留本机记录与队列', async status => {
    await saveRecord(input)
    stubFetch(async () => Response.json({error:{code:'TEST_ERROR',message:'诊断测试'}},{status,headers:{'x-request-id':'request-test','cf-ray':'ray-test','x-worklog-api':'sync-diagnostics-1'}}))
    const state = await syncNow()
    expect(state.phase).toBe('failed')
    expect(state.diagnostic).toMatchObject({stage:'push',status,code:'TEST_ERROR',requestId:'request-test',cfRay:'ray-test',serverApi:'sync-diagnostics-1'})
    expect(await pendingOps()).toHaveLength(1)
    expect((await allRecords())[0].dirty).toBe(1)
    expect((await db.meta.get('lastSyncError'))?.value).toMatchObject({stage:'push',status})
  })
  it('逐操作拒绝不再丢弃队列或误报已同步', async () => {
    await saveRecord(input)
    stubFetch(async (_url, init) => Response.json({results:[{opId:opIds(init)[0],status:'validation_error',errorCode:'RECORD_TYPE_IMMUTABLE'}]}))
    const state = await syncNow()
    expect(state).toMatchObject({phase:'failed',pending:1,diagnostic:{stage:'push',code:'RECORD_TYPE_IMMUTABLE'}})
    expect((await pendingOps())[0]).toMatchObject({lastError:'RECORD_TYPE_IMMUTABLE',attempts:1})
    expect((await allRecords())[0].dirty).toBe(1)
  })
  it('响应缺少操作回执时保留队列并明确报错', async () => {
    await saveRecord(input)
    stubFetch(async () => Response.json({results:[]}))
    expect(await syncNow()).toMatchObject({phase:'failed',pending:1,diagnostic:{code:'INCOMPLETE_RESPONSE'}})
  })
  it('上传成功、下载失败时准确标记下载环节', async () => {
    const record = await saveRecord(input)
    stubFetch(async (url, init) => url.includes('/sync/operations')
      ? Response.json({results:[{opId:opIds(init)[0],status:'success',record:{...record,revision:1}}]})
      : Response.json({error:{code:'INTERNAL',message:'服务器内部错误'}},{status:500,headers:{'x-request-id':'pull-request'}}))
    expect(await syncNow()).toMatchObject({phase:'failed',pending:0,diagnostic:{stage:'pull',requestId:'pull-request',status:500}})
    expect(await allRecords()).toHaveLength(1)
  })
  it('识别网络超时及非预期HTML响应', async () => {
    await saveRecord(input)
    stubFetch(async () => {throw new DOMException('aborted','AbortError')})
    expect(await syncNow()).toMatchObject({diagnostic:{stage:'push',code:'TIMEOUT'}})
    stubFetch(async () => new Response('<html>proxy</html>',{headers:{'content-type':'text/html'}}))
    expect(await syncNow()).toMatchObject({diagnostic:{stage:'push',code:'UNEXPECTED_RESPONSE'}})
    expect(await pendingOps()).toHaveLength(1)
  })
  it('可复制诊断不包含工作内容、Cookie或密码，成功后清除当前错误', async () => {
    await saveRecord({...input,recordType:'overtime',location:null,baseMinutes:0,workContent:'机密工作内容',overtimeMinutes:60})
    await db.meta.put({key:'cookie',value:'secret-cookie'})
    await db.meta.put({key:'password',value:'secret-password'})
    stubFetch(async () => Response.json({error:{code:'INTERNAL',message:'机密服务端错误内容'}},{status:500,headers:{'x-request-id':'safe-request'}}))
    await syncNow()
    const report = await syncDiagnosticReport()
    expect(report).toContain('safe-request')
    expect(report).toContain('待上传操作数：1')
    expect(report).not.toMatch(/机密工作内容|secret-cookie|secret-password|机密服务端错误内容/)
    const record = (await allRecords())[0]
    stubFetch(async (url,init) => url.includes('/sync/operations')
      ? Response.json({results:[{opId:opIds(init)[0],status:'success',record:{...record,revision:1}}]})
      : Response.json({cursor:1,hasMore:false,changes:[]}))
    expect((await syncNow()).phase).toBe('synced')
    expect((await db.meta.get('lastSyncError'))?.value).toBeNull()
  })
})
