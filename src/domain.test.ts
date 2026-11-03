import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayColor,
  defaultStart,
  endTime,
  endTimestamp,
  formatHours,
  monthCells,
  monthlySummary,
  overtimeFromEnd,
  parseOvertime,
  toCSV,
  validateInput,
  type WorkRecord
} from './domain'

const make = (partial: Partial<WorkRecord> = {}): WorkRecord => ({
  id: crypto.randomUUID(),
  workDate: '2026-11-03',
  location: 'art_center',
  startTime: '16:00',
  baseMinutes: 120,
  overtimeMinutes: 0,
  timezone: 'Asia/Shanghai',
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:00:00.000Z',
  revision: 1,
  deletedAt: null,
  ...partial
})

describe('默认开始时间（向下取整到整点）', () => {
  it.each([
    ['09:35', '09:00'],
    ['14:00', '14:00'],
    ['16:15', '16:00'],
    ['19:58', '19:00'],
    ['23:45', '23:00'],
    ['09:59', '09:00']
  ])('当前 %s 时默认开始为 %s', (now, expected) => {
    const [hour, minute] = now.split(':').map(Number)
    expect(defaultStart(new Date(2026, 10, 3, hour, minute))).toBe(expected)
  })
})

describe('结束时间联动', () => {
  it('默认 2 小时', () => {
    expect(endTime('16:00', 120, 0)).toEqual({ time: '18:00', nextDay: false })
  })

  it('基础工时 2h 改 3h 后结束时间延后 1 小时', () => {
    expect(endTime('16:00', 120, 0).time).toBe('18:00')
    expect(endTime('16:00', 180, 0).time).toBe('19:00')
  })

  it('加班 45 分钟', () => {
    expect(endTime('16:00', 180, 45)).toEqual({ time: '19:45', nextDay: false })
  })

  it('跨午夜并标记次日', () => {
    expect(endTime('23:00', 120, 0)).toEqual({ time: '01:00', nextDay: true })
    expect(endTime('23:00', 180, 0)).toEqual({ time: '02:00', nextDay: true })
    expect(endTime('23:45', 120, 60)).toEqual({ time: '02:45', nextDay: true })
  })

  it('手改结束时间反算加班', () => {
    expect(overtimeFromEnd('16:00', '18:30', 120)).toBe(30)
    expect(overtimeFromEnd('23:00', '01:30', 120)).toBe(30)
    expect(overtimeFromEnd('16:00', '17:00', 120)).toBe(-60)
  })
})

describe('加班输入校验', () => {
  it('接受合法值并换算成分钟', () => {
    expect(parseOvertime('0.75')).toBe(45)
    expect(parseOvertime('0.5')).toBe(30)
    expect(parseOvertime('1')).toBe(60)
    expect(parseOvertime('12')).toBe(720)
    expect(parseOvertime('')).toBe(0)
    expect(parseOvertime('  ')).toBe(0)
  })

  it('拒绝负数、非数字、三位小数和超上限', () => {
    for (const value of ['-1', '-0.5', 'abc', '1.234', '12.01', '12.5', '1e3', '0x10']) {
      expect(() => parseOvertime(value)).toThrow()
    }
  })

  it('以分钟为单位累加不会产生浮点误差', () => {
    const total = ['0.1', '0.2', '0.7', '2.05'].map(parseOvertime).reduce((sum, value) => sum + value, 0)
    expect(total).toBe(6 + 12 + 42 + 123)
    expect(Number.isInteger(total)).toBe(true)
  })
})

describe('小时显示', () => {
  it.each([
    [0, '0h'],
    [30, '0.5h'],
    [120, '2h'],
    [135, '2.25h'],
    [150, '2.5h'],
    [900, '15h']
  ])('%i 分钟显示为 %s', (minutes, expected) => {
    expect(formatHours(minutes)).toBe(expected)
  })
})

describe('输入校验', () => {
  it('拒绝非法日期、地点、时间与工时', () => {
    expect(() => validateInput({ workDate: '2025-02-29', location: 'sutuo', startTime: '16:00', baseMinutes: 120, overtimeMinutes: 0, timezone: 'Asia/Shanghai' })).toThrow()
    expect(() => validateInput({ workDate: '2026-11-03', location: 'home' as never, startTime: '16:00', baseMinutes: 120, overtimeMinutes: 0, timezone: 'Asia/Shanghai' })).toThrow()
    expect(() => validateInput({ workDate: '2026-11-03', location: 'sutuo', startTime: '24:00', baseMinutes: 120, overtimeMinutes: 0, timezone: 'Asia/Shanghai' })).toThrow()
    expect(() => validateInput({ workDate: '2026-11-03', location: 'sutuo', startTime: '16:00', baseMinutes: 100 as never, overtimeMinutes: 0, timezone: 'Asia/Shanghai' })).toThrow()
    expect(() => validateInput({ workDate: '2026-11-03', location: 'sutuo', startTime: '16:00', baseMinutes: 120, overtimeMinutes: 721, timezone: 'Asia/Shanghai' })).toThrow()
  })

  it('闰年日期合法', () => {
    expect(() =>
      validateInput({ workDate: '2024-02-29', location: 'art_center', startTime: '09:00', baseMinutes: 180, overtimeMinutes: 0, timezone: 'Asia/Shanghai' })
    ).not.toThrow()
  })
})

describe('日历着色', () => {
  it('按地点集合判断四种状态', () => {
    const art = make()
    const sutuo = make({ location: 'sutuo' })
    const date = art.workDate

    expect(dayColor([], date)).toBe('empty')
    expect(dayColor([art], date)).toBe('art_center')
    expect(dayColor([art, make()], date)).toBe('art_center')
    expect(dayColor([sutuo], date)).toBe('sutuo')
    expect(dayColor([art, sutuo], date)).toBe('mixed')
    expect(dayColor([art, sutuo, make({ startTime: '09:00' })], date)).toBe('mixed')
  })

  it('删除的记录不参与着色', () => {
    const art = make()
    const sutuo = make({ location: 'sutuo' })
    expect(dayColor([art, { ...sutuo, deletedAt: '2026-11-04T00:00:00.000Z' }], art.workDate)).toBe('art_center')
    expect(dayColor([{ ...art, deletedAt: '2026-11-04T00:00:00.000Z' }], art.workDate)).toBe('empty')
  })
})

describe('月度统计', () => {
  it('同日多条只算一天，工时全部累加', () => {
    const records = [
      make({ baseMinutes: 120, overtimeMinutes: 30 }),
      make({ startTime: '09:00', baseMinutes: 180 }),
      make({ location: 'sutuo', startTime: '18:00', baseMinutes: 180 })
    ]
    expect(monthlySummary(records, '2026-11')).toEqual({ totalMinutes: 510, workedDays: 1 })
  })

  it('按 workDate 归属月份，跨月与跨年不串月', () => {
    const records = [
      make({ workDate: '2026-10-31' }),
      make({ workDate: '2026-11-01' }),
      make({ workDate: '2026-12-01' }),
      make({ workDate: '2027-01-01' })
    ]
    expect(monthlySummary(records, '2026-10')).toEqual({ totalMinutes: 120, workedDays: 1 })
    expect(monthlySummary(records, '2026-11')).toEqual({ totalMinutes: 120, workedDays: 1 })
    expect(monthlySummary(records, '2027-01')).toEqual({ totalMinutes: 120, workedDays: 1 })
  })

  it('删除的记录不计入统计', () => {
    const records = [make(), { ...make({ workDate: '2026-11-04' }), deletedAt: 'now' }]
    expect(monthlySummary(records, '2026-11')).toEqual({ totalMinutes: 120, workedDays: 1 })
  })

  it('空月份返回零值', () => {
    expect(monthlySummary([], '2026-11')).toEqual({ totalMinutes: 0, workedDays: 0 })
  })

  it('跨午夜记录仍归属开始日期', () => {
    const record = make({ workDate: '2026-11-30', startTime: '23:00', baseMinutes: 180 })
    expect(monthlySummary([record], '2026-11')).toEqual({ totalMinutes: 180, workedDays: 1 })
    expect(monthlySummary([record], '2026-12')).toEqual({ totalMinutes: 0, workedDays: 0 })
  })
})

describe('月网格', () => {
  it('周一为首列，2026-11-01 是周日所以前面留 6 格', () => {
    const cells = monthCells(2026, 11)
    expect(cells.slice(0, 6).every(cell => cell === null)).toBe(true)
    expect(cells[6]).toBe('2026-11-01')
    expect(cells.filter(Boolean)).toHaveLength(30)
  })

  it('处理闰年与 12 月', () => {
    expect(monthCells(2024, 2).filter(Boolean)).toHaveLength(29)
    expect(monthCells(2025, 2).filter(Boolean)).toHaveLength(28)
    expect(monthCells(2026, 12).filter(Boolean)).toHaveLength(31)
  })
})

describe('日期工具', () => {
  it('addDays 跨月跨年', () => {
    expect(addDays('2026-11-03', 1)).toBe('2026-11-04')
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('endTimestamp 跨午夜时带上日期', () => {
    expect(endTimestamp(make({ startTime: '16:00', baseMinutes: 120, overtimeMinutes: 45 }))).toBe('2026-11-03 18:45')
    expect(endTimestamp(make({ startTime: '23:00', baseMinutes: 180 }))).toBe('2026-11-04 02:00')
  })
})

describe('CSV 导出', () => {
  it('带 BOM、按日期和开始时间排序、排除已删除记录', () => {
    const csv = toCSV([
      make({ workDate: '2026-11-04' }),
      make({ workDate: '2026-11-03', startTime: '18:00' }),
      make({ workDate: '2026-11-03', startTime: '09:00' }),
      make({ deletedAt: 'now' })
    ])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.split('\r\n')[0]).toContain('"日期","地点","开始时间","结束时间","基础工时(h)","加班工时(h)","总工时(h)"')

    const rows = csv.trim().split('\r\n').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('2026-11-03')
    expect(rows[0]?.indexOf('09:00')).toBeGreaterThan(0)
    expect(rows[1]?.indexOf('18:00')).toBeGreaterThan(0)
    expect(rows[2]).toContain('2026-11-04')
  })

  it('跨午夜记录的结束时间写成完整时间戳', () => {
    const csv = toCSV([make({ workDate: '2026-11-03', startTime: '23:00', baseMinutes: 180 })])
    expect(csv).toContain('2026-11-04 02:00')
  })
})
