import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayColor, endTime, hasStandaloneOvertime, monthlySummary, normalizeRecord, overtimeFromEnd, parseOvertime, toCSV, validateInput, type RecordInput, type WorkRecord } from './domain'
import { allRecords, db, DB_NAME, getMeta, pendingOps, saveRecord, mergeServerRecords, replaceAllRecords, deleteRecord } from './storage'
import { rebuildFromServer, syncNow } from './sync'

const input: RecordInput = { workDate: '2026-11-04', recordType: 'overtime', workContent: ' 整理资料 ', location: null, startTime: '23:45', baseMinutes: 0, overtimeMinutes: 60, timezone: 'Asia/Shanghai' }
const make = (overrides: Partial<WorkRecord> = {}): WorkRecord => ({ ...normalizeRecord(input), id: crypto.randomUUID(), createdAt: 'now', updatedAt: 'now', revision: 1, deletedAt: null, ...overrides })
beforeEach(async () => { await db.delete(); await db.open() })
afterEach(() => { vi.unstubAllGlobals() })

describe('独立加班', () => {
  it('工作内容、时长、类型与地点组合必须合法', () => {
    expect(() => validateInput(input)).not.toThrow()
    for (const patch of [{workContent: '  '}, {workContent: '字'.repeat(101)}, {overtimeMinutes: 0}, {overtimeMinutes: 721}, {overtimeMinutes: 1.5}, {location: 'art_center'}, {baseMinutes: 120}, {recordType: 'unknown'}]) {
      expect(() => validateInput({...input, ...patch} as RecordInput)).toThrow()
    }
    expect(() => validateInput({...input, overtimeMinutes: 1, workContent: '😀'.repeat(100)})).not.toThrow()
  })
  it('跨日和所有分钟在时长显示往返后保持精确', () => {
    expect(endTime('23:45', 0, 60)).toEqual({time:'00:45', nextDay:true})
    expect(overtimeFromEnd('23:45', '00:45', 0)).toBe(60)
    expect(overtimeFromEnd('10:00', '10:00', 0)).toBeGreaterThan(720)
    for (let minutes = 1; minutes <= 720; minutes++) {
      expect(parseOvertime(String(Number((minutes / 60).toFixed(2))))).toBe(minutes)
      expect(overtimeFromEnd('23:45', endTime('23:45', 0, minutes).time, 0)).toBe(minutes)
    }
  })
  it('日历保留值班颜色，独立加班标记不受附加加班影响', () => {
    const overtime = make()
    const duty = make({recordType:'duty', workContent:null, location:'art_center', baseMinutes:120, overtimeMinutes:30})
    const green = {...duty, id:crypto.randomUUID(), location:'sutuo' as const}
    expect(dayColor([overtime], input.workDate)).toBe('overtime')
    expect(dayColor([duty, overtime], input.workDate)).toBe('art_center')
    expect(dayColor([green, overtime], input.workDate)).toBe('sutuo')
    expect(dayColor([duty, green, overtime], input.workDate)).toBe('mixed')
    expect(hasStandaloneOvertime([duty], input.workDate)).toBe(false)
    expect(hasStandaloneOvertime([duty, overtime], input.workDate)).toBe(true)
    expect(dayColor([{...overtime, deletedAt:'now'}], input.workDate)).toBe('empty')
  })
  it('基础值班与全部加班小计相加等于总计，同日只算一天', () => {
    const summary = monthlySummary([make(), make({recordType:'duty', workContent:null, location:'art_center', baseMinutes:120, overtimeMinutes:30})], '2026-11')
    expect(summary).toEqual({totalMinutes:210, dutyMinutes:120, overtimeMinutes:90, workedDays:1})
    expect(summary.totalMinutes).toBe(summary.dutyMinutes + summary.overtimeMinutes)
  })
  it('CSV 包含类型、工作内容和跨日结束时间，并防止公式执行', () => {
    const csv = toCSV([make({workContent:'=SUM(A1)'})])
    expect(csv).toContain('"记录类型","工作内容"')
    expect(csv).toContain('"独立加班","\'=SUM(A1)"')
    expect(csv).toContain('2026-11-05 00:45')
    expect(csv).toContain('"2026-11-04",""')
  })
  it('离线增改删及云端重建保留新字段，拒绝转换类型', async () => {
    const created = await saveRecord(input)
    expect(created.workContent).toBe('整理资料')
    const edited = await saveRecord({...input, workContent:'布置场地', overtimeMinutes:6}, created)
    expect(await pendingOps()).toHaveLength(1)
    await expect(saveRecord({...input, recordType:'duty', workContent:null, location:'sutuo', baseMinutes:120}, edited)).rejects.toThrow()
    await mergeServerRecords([{...edited, workContent:'远端旧内容', revision:2}])
    expect((await allRecords())[0].workContent).toBe('布置场地')
    await replaceAllRecords([{...edited, workContent:'远端新内容', revision:3}])
    expect((await allRecords())[0]).toMatchObject({recordType:'overtime', location:null, workContent:'远端新内容', overtimeMinutes:6})
    await deleteRecord((await allRecords())[0])
    expect(await allRecords()).toHaveLength(0)
    expect((await pendingOps())[0].type).toBe('delete')
  })
  it('v10 升级保留旧记录、待同步操作、游标，并补齐新字段', async () => {
    await db.delete()
    const old = new Dexie(DB_NAME)
    old.version(10).stores({records:'id, workDate, location, dirty',ops:'recordId, opId, createdAt',meta:'key'})
    await old.open()
    const legacy = {id:'legacy-record', workDate:input.workDate, location:'art_center', startTime:'10:00', baseMinutes:120, overtimeMinutes:30, timezone:input.timezone, revision:4, createdAt:'then', updatedAt:'then', deletedAt:null, dirty:1}
    const op = {recordId:legacy.id, opId:'legacy-op', type:'update', baseRevision:4, createdAt:'then', attempts:0, lastError:null}
    await old.table('records').put(legacy)
    await old.table('ops').put(op)
    await old.table('meta').put({key:'syncCursor', value:42})
    old.close()
    await db.open()
    expect((await allRecords())[0]).toEqual({...legacy, recordType:'duty', workContent:null})
    expect(await pendingOps()).toEqual([op])
    expect(await getMeta('syncCursor')).toBe(42)
  })
  it('新字段经过冲突重投、增量拉取及全量重建保持完整', async () => {
    const local = await saveRecord(input)
    let pushes = 0
    let lastOpId = ''
    vi.stubGlobal('fetch', vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      if (String(target).includes('/sync/operations')) {
        const op = JSON.parse(String(init?.body)).operations[0]
        expect(op.record).toMatchObject({recordType:'overtime', workContent:'整理资料', location:null, baseMinutes:0})
        pushes++
        if (pushes === 1) {
          lastOpId = op.opId
          return Response.json({results:[{opId:op.opId, status:'conflict', revision:2, record:{...local, revision:2, workContent:'远端'}}]})
        }
        expect(op.opId).not.toBe(lastOpId)
        expect(op.baseRevision).toBe(2)
        return Response.json({results:[{opId:op.opId, status:'success', revision:3, record:{...local, revision:3}}]})
      }
      if (String(target).includes('/sync/full')) return Response.json({cursor:9, records:[{...local, revision:4, workContent:'云端重建'}]})
      return Response.json({cursor:8, hasMore:false, changes:[{seq:8, record:{...local, revision:3}}]})
    }))
    expect((await syncNow()).phase).toBe('synced')
    expect((await allRecords())[0]).toMatchObject({recordType:'overtime', workContent:'整理资料', revision:3, dirty:0})
    expect((await rebuildFromServer()).phase).toBe('synced')
    expect((await allRecords())[0]).toMatchObject({recordType:'overtime', workContent:'云端重建', revision:4})
  })
})
