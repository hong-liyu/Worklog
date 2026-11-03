export type WorkLocation = 'art_center' | 'sutuo'
export type DayColor = 'empty' | WorkLocation | 'mixed'
export const MAX_OVERTIME_MINUTES = 720
export const LOCATION_LABEL: Record<WorkLocation, string> = { art_center: '艺术中心', sutuo: '素拓' }

export interface WorkRecord {
  id: string
  workDate: string
  location: WorkLocation
  startTime: string
  baseMinutes: 120 | 180
  overtimeMinutes: number
  timezone: string
  createdAt: string
  updatedAt: string
  revision: number
  deletedAt: string | null
}

export type RecordInput = Pick<
  WorkRecord,
  'workDate' | 'location' | 'startTime' | 'baseMinutes' | 'overtimeMinutes' | 'timezone'
>

const pad = (value: number): string => String(value).padStart(2, '0')

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** 默认开始时间 = 当前整点（分钟与秒清零）。 */
export function defaultStart(date: Date): string {
  return `${pad(date.getHours())}:00`
}

export function timeMinutes(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('时间格式无效')
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}

/** 结束时间 = 开始时间 + 基础工时 + 加班工时；跨过 24 点时标记 nextDay。 */
export function endTime(start: string, base: number, overtime: number): { time: string; nextDay: boolean } {
  const total = timeMinutes(start) + base + overtime
  return { time: `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`, nextDay: total >= 1440 }
}

/** 由结束时间反算加班分钟；结束时间不大于开始时间时按次日解释。 */
export function overtimeFromEnd(start: string, end: string, base: number): number {
  const from = timeMinutes(start)
  const to = timeMinutes(end)
  const duration = (to <= from ? to + 1440 : to) - from
  return duration - base
}

export function parseOvertime(value: string): number {
  if (value.trim() === '') return 0
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(value)) throw new Error('加班时间最多填写两位小数')
  const hours = Number(value)
  if (hours > MAX_OVERTIME_MINUTES / 60) throw new Error('加班时间不能超过 12 小时')
  return Math.round(hours * 60)
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function validateInput(input: RecordInput): void {
  if (!validDate(input.workDate)) throw new Error('日期无效')
  if (!['art_center', 'sutuo'].includes(input.location)) throw new Error('工作地点无效')
  timeMinutes(input.startTime)
  if (input.baseMinutes !== 120 && input.baseMinutes !== 180) throw new Error('基础工时无效')
  if (
    !Number.isInteger(input.overtimeMinutes) ||
    input.overtimeMinutes < 0 ||
    input.overtimeMinutes > MAX_OVERTIME_MINUTES
  ) {
    throw new Error('加班时间无效')
  }
  if (!input.timezone || input.timezone.length > 100) throw new Error('时区无效')
}

export function formatHours(minutes: number): string {
  return `${Number((minutes / 60).toFixed(2))}h`
}

/** 跨午夜时给出完整日期，避免 CSV 里出现两个相同的 HH:mm。 */
export function endTimestamp(
  record: Pick<WorkRecord, 'workDate' | 'startTime' | 'baseMinutes' | 'overtimeMinutes'>
): string {
  const end = endTime(record.startTime, record.baseMinutes, record.overtimeMinutes)
  return `${end.nextDay ? addDays(record.workDate, 1) : record.workDate} ${end.time}`
}

export function dayColor(records: WorkRecord[], date: string): DayColor {
  const locations = new Set(
    records.filter(record => !record.deletedAt && record.workDate === date).map(record => record.location)
  )
  if (locations.size === 2) return 'mixed'
  if (locations.has('art_center')) return 'art_center'
  if (locations.has('sutuo')) return 'sutuo'
  return 'empty'
}

export function monthlySummary(
  records: WorkRecord[],
  month: string
): { totalMinutes: number; workedDays: number } {
  const active = records.filter(record => !record.deletedAt && record.workDate.startsWith(`${month}-`))
  return {
    totalMinutes: active.reduce((sum, record) => sum + record.baseMinutes + record.overtimeMinutes, 0),
    workedDays: new Set(active.map(record => record.workDate)).size
  }
}

/** 周一为首列的月网格，非本月格子用 null 占位。 */
export function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(year, month - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const days = new Date(year, month, 0).getDate()
  return [
    ...Array(offset).fill(null),
    ...Array.from({ length: days }, (_, index) => `${year}-${pad(month)}-${pad(index + 1)}`)
  ]
}

function csvCell(value: string): string {
  const safe = /^\s*[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

export function toCSV(records: WorkRecord[]): string {
  const rows = records
    .filter(record => !record.deletedAt)
    .sort(
      (left, right) =>
        left.workDate.localeCompare(right.workDate) || left.startTime.localeCompare(right.startTime)
    )

  const header = ['日期', '地点', '开始时间', '结束时间', '基础工时(h)', '加班工时(h)', '总工时(h)']
  const data = rows.map(record => [
    record.workDate,
    LOCATION_LABEL[record.location],
    record.startTime,
    endTimestamp(record),
    String(Number((record.baseMinutes / 60).toFixed(2))),
    String(Number((record.overtimeMinutes / 60).toFixed(2))),
    String(Number(((record.baseMinutes + record.overtimeMinutes) / 60).toFixed(2)))
  ])

  return `\ufeff${[header, ...data].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}
