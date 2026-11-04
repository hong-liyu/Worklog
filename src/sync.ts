import { request } from './api'
import type { WorkRecord } from './domain'
import {
  allRecords,
  applyOperationSuccess,
  dropOperation,
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

async function run(): Promise<SyncState> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { phase: 'offline', pending: await pendingCount() }
  }

  try {
    await setMeta('syncStartedAt', new Date().toISOString())
    const pushOutcome = await push()
    if (pushOutcome === 'unauthorized') return { phase: 'unauthorized', pending: await pendingCount() }
    if (pushOutcome === 'conflict') return { phase: 'conflict', pending: await pendingCount() }

    const pullOutcome = await pullChanges()
    if (pullOutcome === 'unauthorized') return { phase: 'unauthorized', pending: await pendingCount() }

    const pending = await pendingCount()
    await setMeta('lastSyncAt', new Date().toISOString())
    await setMeta('lastSyncError', null)
    return { phase: pending > 0 ? 'pending' : 'synced', pending }
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步失败'
    await setMeta('lastSyncError', { at: new Date().toISOString(), message })
    return { phase: 'failed', pending: await pendingCount() }
  }
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

async function push(): Promise<'ok' | 'unauthorized' | 'conflict'> {
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
        await dropOperation(op, 'LOCAL_RECORD_MISSING')
        continue
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

    const response = await request('/sync/operations', { method: 'POST', body: { operations } })
    if (response.status === 401) return 'unauthorized'
    if (!response.ok) throw new Error(`提交失败 (${response.status})`)

    const body = (await response.json()) as { results: OperationResult[] }
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
        await dropOperation(op, result.errorCode ?? 'VALIDATION_ERROR')
      }
    }

    // 冲突 rebase 之后重来一轮：baseRevision 已换成服务器最新版本。
    if (conflicted) continue
  }

  return (await pendingCount()) > 0 ? 'conflict' : 'ok'
}

async function pullChanges(): Promise<'ok' | 'unauthorized'> {
  let cursor = (await getMeta<number>('syncCursor')) ?? 0

  for (let round = 0; round < 60; round += 1) {
    const response = await request(`/sync?after=${cursor}&limit=200`)
    if (response.status === 401) return 'unauthorized'
    if (!response.ok) throw new Error(`拉取失败 (${response.status})`)

    const body = (await response.json()) as {
      cursor: number
      hasMore: boolean
      changes: { seq: number; record: WorkRecord }[]
    }

    await mergeServerRecords(body.changes.map(change => change.record))
    cursor = body.cursor
    await setMeta('syncCursor', cursor)
    if (!body.hasMore) break
  }

  return 'ok'
}

/** 手动「从云端重建」：丢掉本地缓存，按服务器全量数据重来。 */
export async function rebuildFromServer(): Promise<SyncState> {
  try {
    const response = await request('/sync/full')
    if (response.status === 401) return { phase: 'unauthorized', pending: 0 }
    if (!response.ok) throw new Error(`重建失败 (${response.status})`)

    const body = (await response.json()) as { cursor: number; records: WorkRecord[] }
    await replaceAllRecords(body.records)
    await setMeta('syncCursor', body.cursor)
    await setMeta('lastSyncAt', new Date().toISOString())
    return { phase: 'synced', pending: 0 }
  } catch (error) {
    await setMeta('lastSyncError', {
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : '重建失败'
    })
    return { phase: 'failed', pending: await pendingCount() }
  }
}
