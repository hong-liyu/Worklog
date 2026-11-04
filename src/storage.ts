import Dexie, { type Table } from 'dexie'
import { normalizeRecord, validateInput, type RecordInput, type WorkRecord } from './domain'

export const DB_NAME = 'worklog'
export const DB_VERSION = 11

/** 本地记录额外带 dirty 标记：1 表示还有未确认的本地修改。 */
export type LocalRecord = WorkRecord & { dirty: 0 | 1 }
export type OpType = 'create' | 'update' | 'delete'

/**
 * 一条记录最多只有一个待同步操作，主键就是 recordId。
 * 操作只存元信息，内容在推送时从 records 表读，避免两份内容打架。
 */
export interface PendingOp {
  recordId: string
  opId: string
  type: OpType
  baseRevision: number
  createdAt: string
  attempts: number
  lastError: string | null
}

export interface Meta {
  key: string
  value: unknown
}

class WorklogDB extends Dexie {
  records!: Table<LocalRecord, string>
  ops!: Table<PendingOp, string>
  meta!: Table<Meta, string>

  constructor() {
    super(DB_NAME)
    // 版本号从 10 起，是为了跳过早期原型（v1–v4）的表结构；
    // 旧库里未声明的表会在升级时被删除，记录本身结构兼容。
    this.version(10).stores({
      records: 'id, workDate, location, dirty',
      ops: 'recordId, opId, createdAt',
      meta: 'key'
    })
    this.version(DB_VERSION).stores({
      records: 'id, workDate, location, dirty', ops: 'recordId, opId, createdAt', meta: 'key'
    }).upgrade(transaction => transaction.table('records').toCollection().modify(record => {
      record.recordType ??= 'duty'
      record.workContent ??= null
    }))
  }
}

export const db = new WorklogDB()

export const getMeta = async <T>(key: string): Promise<T | undefined> =>
  (await db.meta.get(key))?.value as T | undefined

export const setMeta = (key: string, value: unknown): Promise<string> => db.meta.put({ key, value })
export const deleteMeta = (key: string): Promise<void> => db.meta.delete(key)

export const allRecords = (): Promise<LocalRecord[]> => db.records.toArray()
export const getRecord = (id: string): Promise<LocalRecord | undefined> => db.records.get(id)
export const pendingOps = (): Promise<PendingOp[]> => db.ops.orderBy('createdAt').toArray()
export const pendingCount = (): Promise<number> => db.ops.count()
export const getOp = (recordId: string): Promise<PendingOp | undefined> => db.ops.get(recordId)

export async function saveRecord(input: RecordInput, existing?: LocalRecord): Promise<LocalRecord> {
  validateInput(input)
  if (existing && (input.recordType ?? 'duty') !== existing.recordType) throw new Error('不能修改记录类型')
  const normalized = normalizeRecord(input)
  const now = new Date().toISOString()
  const record: LocalRecord = existing
    ? { ...existing, ...normalized, updatedAt: now, deletedAt: null, dirty: 1 }
    : {
        ...normalized,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        revision: 0,
        deletedAt: null,
        dirty: 1
      }

  await db.transaction('rw', db.records, db.ops, async () => {
    await db.records.put(record)
    // 已有待同步操作时保持 opId 与 baseRevision 不变：重试始终用同一个 opId，
    // 服务器凭 operation_receipts 去重。
    if (await db.ops.get(record.id)) return
    await db.ops.put({
      recordId: record.id,
      opId: crypto.randomUUID(),
      type: record.revision === 0 ? 'create' : 'update',
      baseRevision: record.revision,
      createdAt: now,
      attempts: 0,
      lastError: null
    })
  })

  return record
}

export async function deleteRecord(record: LocalRecord): Promise<void> {
  const now = new Date().toISOString()
  await db.transaction('rw', db.records, db.ops, async () => {
    await db.records.delete(record.id)
    if (record.revision === 0) {
      // 从未同步过的新记录：直接取消，不必通知服务器。
      await db.ops.delete(record.id)
      return
    }
    await db.ops.put({
      recordId: record.id,
      opId: crypto.randomUUID(),
      type: 'delete',
      baseRevision: record.revision,
      createdAt: now,
      attempts: 0,
      lastError: null
    })
  })
}

/** 推送成功后用服务器返回值覆盖本地，并清掉对应操作。 */
export async function applyOperationSuccess(op: PendingOp, wire: WorkRecord): Promise<void> {
  await db.transaction('rw', db.records, db.ops, async () => {
    const current = await db.ops.get(op.recordId)
    const isLatest = current?.opId === op.opId
    if (isLatest) await db.ops.delete(op.recordId)

    if (wire.deletedAt) {
      await db.records.delete(wire.id)
      return
    }
    await db.records.put({ ...normalizeRecord(wire), dirty: isLatest ? 0 : 1 })
  })
}

/** 版本冲突：换新 opId，以服务器最新 revision 为基准重投一次本机内容。 */
export async function rebaseOperation(op: PendingOp, baseRevision: number): Promise<void> {
  await db.transaction('rw', db.ops, async () => {
    const current = await db.ops.get(op.recordId)
    if (!current || current.opId !== op.opId) return
    await db.ops.put({
      ...current,
      opId: crypto.randomUUID(),
      baseRevision,
      attempts: 0,
      lastError: 'conflict'
    })
  })
}

/** Rejected writes remain queued until corrected or explicitly deleted by the user. */
export async function markOperationFailure(op: PendingOp, reason: string): Promise<void> {
  await db.transaction('rw', db.ops, async () => {
    const current = await db.ops.get(op.recordId)
    if (!current || current.opId !== op.opId) return
    await db.ops.update(op.recordId, { attempts: current.attempts + 1, lastError: reason })
  })
}

/** 拉取合并：本地有未同步操作的记录一律以本地为准，不用云端静默覆盖。 */
export async function mergeServerRecords(records: WorkRecord[]): Promise<void> {
  await db.transaction('rw', db.records, db.ops, async () => {
    for (const record of records) {
      if (await db.ops.get(record.id)) continue
      if (record.deletedAt) await db.records.delete(record.id)
      else await db.records.put({ ...normalizeRecord(record), dirty: 0 })
    }
  })
}

export async function replaceAllRecords(records: WorkRecord[]): Promise<void> {
  await db.transaction('rw', db.records, db.ops, async () => {
    await db.records.clear()
    await db.ops.clear()
    for (const record of records) {
      if (record.deletedAt) continue
      await db.records.put({ ...normalizeRecord(record), dirty: 0 })
    }
  })
}

export async function importRecords(records: WorkRecord[]): Promise<number> {
  let imported = 0
  await db.transaction('rw', db.records, db.ops, async () => {
    for (const record of records) {
      if (await db.records.get(record.id)) continue
      const now = new Date().toISOString()
      await db.records.put({ ...normalizeRecord(record), revision: 0, deletedAt: null, updatedAt: now, dirty: 1 })
      await db.ops.put({
        recordId: record.id,
        opId: crypto.randomUUID(),
        type: 'create',
        baseRevision: 0,
        createdAt: now,
        attempts: 0,
        lastError: null
      })
      imported += 1
    }
  })
  return imported
}

/** 退出登录时清空本机业务数据。 */
export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', db.records, db.ops, db.meta, async () => {
    await db.records.clear()
    await db.ops.clear()
    await db.meta.clear()
  })
}
