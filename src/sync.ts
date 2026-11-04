import { request, type RequestOptions } from './api'
import type { WorkRecord } from './domain'
import {
  allRecords,
  applyOperationSuccess,
  markOperationFailure,
  getMeta,
  mergeServerRecords,
  pendingCount,
  pendingOps,
  rebaseOperation,
  replaceAllRecords,
  setMeta,
  type LocalRecord,
  type PendingOp
} from './storage'

export type SyncPhase = 'idle' | 'offline' | 'syncing' | 'synced' | 'pending' | 'failed' | 'unauthorized' | 'conflict'

export interface SyncState {
  phase: SyncPhase
  pending: number
  diagnostic?: SyncDiagnostic
}

interface OperationResult {
  opId: string
  status: 'success' | 'conflict' | 'validation_error'
  revision?: number
  record?: WorkRecord
  errorCode?: string
}

interface OperationBody {
  opId: string
  type: 'create' | 'update' | 'delete'
  recordId: string
  baseRevision: number
  record?: Record<string, unknown>
}

// Workers 免费版每个请求最多 50 个子请求，而每个操作要占 3-5 次 D1 调用。
// 单批 6 个操作 + 鉴权 + 收尾查询 ≈ 32 次，留足余量。
const PUSH_BATCH = 6

let inflight: Promise<SyncState> | null = null

/** 同一时刻只跑一个同步；并发调用直接复用正在进行的这一次。 */
export function syncNow(): Promise<SyncState> {
  if (!inflight) {
    inflight = run().finally(() => {
      inflight = null
    })
  }
  return inflight
}

export type SyncStage = 'local' | 'push' | 'pull' | 'rebuild'
export interface SyncDiagnostic {
  at: string
  stage: SyncStage
  code: string
  message: string
  status?: number
  requestId?: string
  cfRay?: string
  serverApi?: string
  recordId?: string
}

class SyncFailure extends Error {
  constructor(readonly diagnostic: SyncDiagnostic) { super(diagnostic.message) }
}

function failure(stage: SyncStage, code: string, message: string, extra: Partial<SyncDiagnostic> = {}): SyncFailure {
  return new SyncFailure({ at: new Date().toISOString(), stage, code, message, ...extra })
}

async function syncRequest<T>(stage: SyncStage, path: string, options: RequestOptions = {}): Promise<{ body: T; context: Partial<SyncDiagnostic> }> {
  let response: Response
  try { response = await request(path, options) }
  catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError'
    throw failure(stage, timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout
      ? '连接超时，记录仍保存在本机，请稍后重试'
      : '未能连接同步服务，请切换网络后重试；记录仍保存在本机')
  }
  const context = { status: response.status, requestId: response.headers.get('x-request-id') ?? undefined,
    cfRay: response.headers.get('cf-ray') ?? undefined, serverApi: response.headers.get('x-worklog-api') ?? undefined }
  let body: unknown
  try { body = await response.json() }
  catch {
    if (response.ok) throw failure(stage, 'UNEXPECTED_RESPONSE', '同步服务返回了非预期页面，请核对网址或稍后重试', context)
    body = {}
  }
  if (!response.ok) {
    const detail = body as { error?: { code?: string; message?: string } }
    // Only accept structured application errors, never include raw HTML or request contents.
    const code = typeof detail?.error?.code === 'string' ? detail.error.code : `HTTP_${response.status}`
    const message = typeof detail?.error?.message === 'string' ? detail.error.message.slice(0, 240)
      : response.status === 401 ? '登录状态失效，请重新登录'
      : response.status === 403 ? '请求被拒绝，请联系管理员并提供诊断编号'
      : `同步服务返回错误（${response.status}），请将诊断提供给管理员`
    throw failure(stage, code, message, context)
  }
  return { body: body as T, context }
}

async function recordFailure(error: unknown): Promise<SyncState> {
  const diagnostic = error instanceof SyncFailure ? error.diagnostic
    : failure('local', error instanceof Error ? error.name : 'LOCAL_ERROR',
      '处理本机数据时出错，请保留当前浏览器数据并联系管理员').diagnostic
  try { await setMeta('lastSyncError', diagnostic) } catch { /* Storage failures must still be visible in memory. */ }
  let pending = 0
  try { pending = await pendingCount() } catch { /* Diagnostics identify the unavailable local store. */ }
  return { phase: diagnostic.status === 401 ? 'unauthorized' : 'failed', pending, diagnostic }
}

async function run(): Promise<SyncState> {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { phase: 'offline', pending: await pendingCount() }
    }
    await setMeta('syncStartedAt', new Date().toISOString())
    const pushOutcome = await push()
    if (pushOutcome === 'conflict') return { phase: 'conflict', pending: await pendingCount() }
    await pullChanges()
    const pending = await pendingCount()
    await setMeta('lastSyncAt', new Date().toISOString())
    await setMeta('lastSyncError', null)
    return { phase: pending > 0 ? 'pending' : 'synced', pending }
  } catch (error) { return recordFailure(error) }
}

function toPayload(record: LocalRecord): Record<string, unknown> {
  return {
    id: record.id,
    workDate: record.workDate,
    recordType: record.recordType,
    workContent: record.workContent,
    location: record.location,
    startTime: record.startTime,
    baseMinutes: record.baseMinutes,
    overtimeMinutes: record.overtimeMinutes,
    timezone: record.timezone
  }
}

async function push(): Promise<'ok' | 'conflict'> {
  for (let round = 0; round < 30; round += 1) {
    const queued = await pendingOps()
    if (queued.length === 0) return 'ok'

    const records = new Map((await allRecords()).map(record => [record.id, record]))
    const batch = queued.slice(0, PUSH_BATCH)
    const operations: OperationBody[] = []
    const sent: PendingOp[] = []

    for (const op of batch) {
      const record = records.get(op.recordId)
      if (op.type !== 'delete' && !record) {
        await markOperationFailure(op, 'LOCAL_RECORD_MISSING')
        throw failure('push', 'LOCAL_RECORD_MISSING', '待上传记录的本机数据缺失，请保留现有数据并联系管理员', { recordId: op.recordId })
      }
      operations.push(
        op.type === 'delete'
          ? { opId: op.opId, type: 'delete', recordId: op.recordId, baseRevision: op.baseRevision }
          : {
              opId: op.opId,
              type: op.type,
              recordId: op.recordId,
              baseRevision: op.baseRevision,
              record: toPayload(record as LocalRecord)
            }
      )
      sent.push(op)
    }

    if (operations.length === 0) continue

    const { body, context } = await syncRequest<{ results: OperationResult[] }>('push', '/sync/operations', { method: 'POST', body: { operations } })
    if (!body || !Array.isArray(body.results)) throw failure('push', 'UNEXPECTED_RESPONSE', '上传结果格式异常，记录仍保留待同步', context)
    let rejected: SyncFailure | undefined
    let conflicted = false

    for (const result of body.results) {
      const op = sent.find(item => item.opId === result.opId)
      if (!op) continue
      if (result.status === 'success' && result.record) {
        await applyOperationSuccess(op, result.record)
      } else if (result.status === 'conflict' && typeof result.revision === 'number') {
        await rebaseOperation(op, result.revision)
        conflicted = true
      } else {
        const code = result.errorCode ?? 'UNEXPECTED_OPERATION_RESULT'
        await markOperationFailure(op, code)
        rejected ??= failure('push', code, '有记录未被云端接受，请检查记录或联系管理员；本机修改仍保留', { ...context, recordId: op.recordId })
      }
    }

    for (const op of sent) {
      if (!body.results.some(result => result.opId === op.opId)) rejected ??= failure('push', 'INCOMPLETE_RESPONSE', '云端未确认全部上传结果，未确认记录仍保留待同步', context)
    }
    if (rejected) throw rejected

    // 冲突 rebase 之后重来一轮：baseRevision 已换成服务器最新版本。
    if (conflicted) continue
  }

  return (await pendingCount()) > 0 ? 'conflict' : 'ok'
}

async function pullChanges(): Promise<void> {
  let cursor = (await getMeta<number>('syncCursor')) ?? 0
  for (let round = 0; round < 60; round += 1) {
    const { body, context } = await syncRequest<{
      cursor: number; hasMore: boolean; changes: { seq: number; record: WorkRecord }[]
    }>('pull', `/sync?after=${cursor}&limit=200`)
    if (!body || !Array.isArray(body.changes) || !Number.isSafeInteger(body.cursor) || body.cursor < cursor || typeof body.hasMore !== 'boolean') {
      throw failure('pull', 'UNEXPECTED_RESPONSE', '下载结果格式异常，本机数据未被清空', context)
    }
    await mergeServerRecords(body.changes.map(change => change.record))
    cursor = body.cursor
    await setMeta('syncCursor', cursor)
    if (!body.hasMore) break
  }

}

/** 手动「从云端重建」：丢掉本地缓存，按服务器全量数据重来。 */
export async function rebuildFromServer(): Promise<SyncState> {
  try {
    const { body, context } = await syncRequest<{ cursor: number; records: WorkRecord[] }>('rebuild', '/sync/full')
    if (!body || !Array.isArray(body.records) || !Number.isSafeInteger(body.cursor) || body.cursor < 0) {
      throw failure('rebuild', 'UNEXPECTED_RESPONSE', '云端重建结果异常，本机数据未被清空', context)
    }
    await replaceAllRecords(body.records)
    await setMeta('syncCursor', body.cursor)
    await setMeta('lastSyncAt', new Date().toISOString())
    await setMeta('lastSyncError', null)
    return { phase: 'synced', pending: 0 }
  } catch (error) { return recordFailure(error) }
}
