import { HttpError } from './http'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const TIMEZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/
const MAX_OPERATIONS = 100
const MAX_OVERTIME_MINUTES = 720

export type WorkLocation = 'art_center' | 'sutuo'
export type OpType = 'create' | 'update' | 'delete'
export type OperationStatus = 'success' | 'conflict' | 'validation_error'

export interface RecordPayload {
  id: string
  workDate: string
  recordType: 'duty' | 'overtime'
  workContent: string | null
  location: WorkLocation | null
  startTime: string
  baseMinutes: 0 | 120 | 180
  overtimeMinutes: number
  timezone: string
}

export interface Operation {
  opId: string
  type: OpType
  recordId: string
  baseRevision: number
  record: RecordPayload | null
}

function invalid(message: string): never {
  throw new HttpError(400, 'VALIDATION_ERROR', message)
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(message)
  return value as Record<string, unknown>
}

export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

export function parseRecord(value: unknown): RecordPayload {
  const raw = asObject(value, '记录格式无效')
  const id = raw.id
  if (typeof id !== 'string' || !ID_RE.test(id)) invalid('记录标识无效')

  const workDate = raw.workDate
  if (typeof workDate !== 'string' || !isRealDate(workDate)) invalid('日期无效')

  const recordType = raw.recordType ?? 'duty'
  if (recordType !== 'duty' && recordType !== 'overtime') invalid('记录类型无效')
  const location = raw.location
  const workContent = typeof raw.workContent === 'string' ? raw.workContent.trim() : null
  if (recordType === 'duty') {
    if (location !== 'art_center' && location !== 'sutuo') invalid('工作地点无效')
    if (raw.workContent != null) invalid('值班记录不需要工作内容')
  } else {
    if (location !== null) invalid('独立加班不包含地点')
    if (!workContent || Array.from(workContent).length > 100) invalid('请填写工作内容，最多100字')
  }

  const startTime = raw.startTime
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) invalid('开始时间无效')

  const baseMinutes = raw.baseMinutes
  if (recordType === 'duty' ? baseMinutes !== 120 && baseMinutes !== 180 : baseMinutes !== 0) invalid('基础工时无效')

  const overtimeMinutes = raw.overtimeMinutes
  if (
    typeof overtimeMinutes !== 'number' ||
    !Number.isInteger(overtimeMinutes) ||
    overtimeMinutes < (recordType === 'overtime' ? 1 : 0) ||
    overtimeMinutes > MAX_OVERTIME_MINUTES
  ) {
    invalid('加班时间无效')
  }

  const timezone = raw.timezone
  if (typeof timezone !== 'string' || !TIMEZONE_RE.test(timezone)) invalid('时区无效')

  return { id, workDate, recordType, workContent, location: location as WorkLocation | null, startTime, baseMinutes: baseMinutes as 0 | 120 | 180, overtimeMinutes, timezone }
}

export function parseOperations(value: unknown): Operation[] {
  if (!Array.isArray(value) || value.length === 0) invalid('操作列表不能为空')
  if (value.length > MAX_OPERATIONS) invalid(`单次最多提交 ${MAX_OPERATIONS} 个操作`)

  return value.map(item => {
    const raw = asObject(item, '操作格式无效')

    const opId = raw.opId
    if (typeof opId !== 'string' || !ID_RE.test(opId)) invalid('操作标识无效')

    const type = raw.type
    if (type !== 'create' && type !== 'update' && type !== 'delete') invalid('操作类型无效')

    const baseRevision = raw.baseRevision ?? 0
    if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) {
      invalid('基础版本号无效')
    }

    if (type === 'create') {
      const record = parseRecord(raw.record)
      return { opId, type, recordId: record.id, baseRevision: 0, record }
    }

    const recordId = raw.recordId ?? (raw.record as Record<string, unknown> | undefined)?.id
    if (typeof recordId !== 'string' || !ID_RE.test(recordId)) invalid('记录标识无效')

    if (type === 'update') {
      const record = parseRecord(raw.record)
      if (record.id !== recordId) invalid('记录标识与修改目标不一致')
      return { opId, type, recordId, baseRevision, record }
    }

    return { opId, type, recordId, baseRevision, record: null }
  })
}

export function parseRevisionCursor(value: string | null): number {
  if (value === null || value === '') return 0
  if (!/^\d{1,15}$/.test(value)) invalid('同步游标无效')
  return Number(value)
}

export function parseLimit(value: string | null): number {
  if (value === null || value === '') return 200
  if (!/^\d{1,4}$/.test(value)) invalid('分页大小无效')
  return Math.min(Math.max(Number(value), 1), 200)
}
