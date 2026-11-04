import type { D1Database } from './types'
import type { Operation, OperationStatus, RecordPayload } from './validate'

export interface WireRecord {
  id: string
  workDate: string
  recordType: 'duty' | 'overtime'
  workContent: string | null
  location: string | null
  startTime: string
  baseMinutes: number
  overtimeMinutes: number
  timezone: string
  createdAt: string
  updatedAt: string
  revision: number
  deletedAt: string | null
}

interface StoredRow {
  id: string
  work_date: string
  record_type: 'duty' | 'overtime'
  work_content: string | null
  location: string | null
  start_time: string
  base_minutes: number
  overtime_minutes: number
  timezone: string
  created_at: string
  updated_at: string
  revision: number
  deleted_at: string | null
}

export interface OperationResult {
  opId: string
  status: OperationStatus
  revision?: number
  record?: WireRecord
  errorCode?: string
}

interface ChangeLogEntry {
  recordId: string
  type: string
  wire: WireRecord
}

function toWire(row: StoredRow): WireRecord {
  return {
    id: row.id,
    workDate: row.work_date,
    recordType: row.record_type,
    workContent: row.work_content,
    location: row.location,
    startTime: row.start_time,
    baseMinutes: row.base_minutes,
    overtimeMinutes: row.overtime_minutes,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    deletedAt: row.deleted_at
  }
}

function selectOne(db: D1Database, userId: string, recordId: string): Promise<StoredRow | null> {
  return db
    .prepare('SELECT * FROM work_records WHERE id = ? AND user_id = ?')
    .bind(recordId, userId)
    .first<StoredRow>()
}

async function persist(
  db: D1Database,
  userId: string,
  opId: string,
  result: OperationResult,
  log: ChangeLogEntry | null
): Promise<void> {
  const now = new Date().toISOString()
  const run = () => {
    const statements = []
    if (log) {
      statements.push(
        db
          .prepare(
            'INSERT INTO change_log (user_id, record_id, change_type, snapshot, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(userId, log.recordId, log.type, JSON.stringify(log.wire), now)
      )
    }
    statements.push(
      db
        .prepare(
          'INSERT OR REPLACE INTO operation_receipts (op_id, user_id, response_payload, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(opId, userId, JSON.stringify(result), now)
    )
    return db.batch(statements)
  }

  try {
    await run()
  } catch {
    // D1 没有交互式事务：记录写入与日志写入分两步，失败重试一次缩小丢日志的窗口。
    await run()
  }
}

function success(opId: string, wire: WireRecord, log: ChangeLogEntry | null) {
  return { result: { opId, status: 'success' as OperationStatus, revision: wire.revision, record: wire }, log }
}

function failure(opId: string, status: OperationStatus, errorCode: string) {
  return { result: { opId, status, errorCode }, log: null }
}

async function applyCreate(db: D1Database, userId: string, op: Operation) {
  const record = op.record as RecordPayload
  const now = new Date().toISOString()
  const inserted = await db
    .prepare(
      `INSERT INTO work_records
         (id, user_id, work_date, record_type, work_content, location, start_time, base_minutes, overtime_minutes, timezone, created_at, updated_at, revision, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      record.id,
      userId,
      record.workDate,
      record.recordType,
      record.workContent,
      record.location,
      record.startTime,
      record.baseMinutes,
      record.overtimeMinutes,
      record.timezone,
      now,
      now
    )
    .run()

  if (inserted.meta.changes === 0) {
    const existing = await selectOne(db, userId, record.id)
    if (!existing) return failure(op.opId, 'validation_error', 'RECORD_ID_TAKEN')
    // 同一 id 已存在：贴着服务器版本当作成功，客户端以返回值为准。
    return { result: { opId: op.opId, status: 'success' as OperationStatus, revision: existing.revision, record: toWire(existing) }, log: null }
  }

  const wire: WireRecord = { ...record, createdAt: now, updatedAt: now, revision: 1, deletedAt: null }
  return success(op.opId, wire, { recordId: record.id, type: 'create', wire })
}

async function applyUpdate(db: D1Database, userId: string, op: Operation) {
  const record = op.record as RecordPayload
  const before = await selectOne(db, userId, op.recordId)
  if (!before) return failure(op.opId, 'validation_error', 'RECORD_NOT_FOUND')
  if (before.deleted_at) return failure(op.opId, 'validation_error', 'RECORD_DELETED')
  if (before.record_type !== record.recordType) return failure(op.opId, 'validation_error', 'RECORD_TYPE_IMMUTABLE')

  const now = new Date().toISOString()
  const updated = await db
    .prepare(
      `UPDATE work_records
          SET work_date = ?, record_type = ?, work_content = ?, location = ?, start_time = ?, base_minutes = ?, overtime_minutes = ?,
              timezone = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND user_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .bind(
      record.workDate,
      record.recordType,
      record.workContent,
      record.location,
      record.startTime,
      record.baseMinutes,
      record.overtimeMinutes,
      record.timezone,
      now,
      op.recordId,
      userId,
      op.baseRevision
    )
    .run()

  if (updated.meta.changes === 0) {
    const current = await selectOne(db, userId, op.recordId)
    if (!current) return failure(op.opId, 'validation_error', 'RECORD_NOT_FOUND')
    if (current.deleted_at) return failure(op.opId, 'validation_error', 'RECORD_DELETED')
    return {
      result: { opId: op.opId, status: 'conflict' as OperationStatus, revision: current.revision, record: toWire(current) },
      log: null
    }
  }

  const wire: WireRecord = {
    ...record,
    createdAt: before.created_at,
    updatedAt: now,
    revision: op.baseRevision + 1,
    deletedAt: null
  }
  return success(op.opId, wire, { recordId: record.id, type: 'update', wire })
}

async function applyDelete(db: D1Database, userId: string, op: Operation) {
  const before = await selectOne(db, userId, op.recordId)
  if (!before) return failure(op.opId, 'validation_error', 'RECORD_NOT_FOUND')
  if (before.deleted_at) return success(op.opId, toWire(before), null)

  const now = new Date().toISOString()
  const updated = await db
    .prepare(
      `UPDATE work_records
          SET deleted_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND user_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .bind(now, now, op.recordId, userId, op.baseRevision)
    .run()

  if (updated.meta.changes === 0) {
    const current = await selectOne(db, userId, op.recordId)
    if (!current) return failure(op.opId, 'validation_error', 'RECORD_NOT_FOUND')
    if (current.deleted_at) return success(op.opId, toWire(current), null)
    return {
      result: { opId: op.opId, status: 'conflict' as OperationStatus, revision: current.revision, record: toWire(current) },
      log: null
    }
  }

  const wire: WireRecord = { ...toWire(before), updatedAt: now, revision: op.baseRevision + 1, deletedAt: now }
  return success(op.opId, wire, { recordId: wire.id, type: 'delete', wire })
}

export async function applyOperations(
  db: D1Database,
  userId: string,
  operations: Operation[]
): Promise<{ results: OperationResult[]; cursor: number }> {
  const results: OperationResult[] = []

  for (const operation of operations) {
    const receipt = await db
      .prepare('SELECT response_payload FROM operation_receipts WHERE op_id = ? AND user_id = ?')
      .bind(operation.opId, userId)
      .first<{ response_payload: string }>()

    if (receipt) {
      results.push(JSON.parse(receipt.response_payload) as OperationResult)
      continue
    }

    let outcome
    if (operation.type === 'create') outcome = await applyCreate(db, userId, operation)
    else if (operation.type === 'update') outcome = await applyUpdate(db, userId, operation)
    else outcome = await applyDelete(db, userId, operation)

    if (outcome.result.status !== 'validation_error') {
      await persist(db, userId, operation.opId, outcome.result, outcome.log)
    }
    results.push(outcome.result)
  }

  const cursorRow = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE user_id = ?')
    .bind(userId)
    .first<{ seq: number }>()

  return { cursor: cursorRow?.seq ?? 0, results }
}

export async function pull(
  db: D1Database,
  userId: string,
  after: number,
  limit: number
): Promise<{ cursor: number; hasMore: boolean; changes: { seq: number; record: WireRecord }[] }> {
  const rows = await db
    .prepare(
      `SELECT c.seq AS seq, r.*
         FROM change_log c
         JOIN work_records r ON r.id = c.record_id AND r.user_id = c.user_id
        WHERE c.user_id = ? AND c.seq > ?
        ORDER BY c.seq ASC
        LIMIT ?`
    )
    .bind(userId, after, limit)
    .all<StoredRow & { seq: number }>()

  const changes = rows.results.map(row => ({ seq: row.seq, record: toWire(row) }))
  const cursor = changes.length > 0 ? changes[changes.length - 1].seq : after
  return { cursor, hasMore: changes.length === limit, changes }
}

export async function full(
  db: D1Database,
  userId: string
): Promise<{ cursor: number; records: WireRecord[] }> {
  const rows = await db
    .prepare('SELECT * FROM work_records WHERE user_id = ? ORDER BY work_date ASC, start_time ASC')
    .bind(userId)
    .all<StoredRow>()

  const cursorRow = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE user_id = ?')
    .bind(userId)
    .first<{ seq: number }>()

  return { cursor: cursorRow?.seq ?? 0, records: rows.results.map(toWire) }
}
