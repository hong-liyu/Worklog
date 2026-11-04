import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createTestDatabase } from './testing'
import { parseOperations, parseRecord } from './validate'
import { applyOperations, full, pull } from './records'

const payload = {id:'overtime-record', recordType:'overtime', workContent:' 整理资料 ', workDate:'2026-11-04', location:null, startTime:'23:45', baseMinutes:0, overtimeMinutes:60, timezone:'Asia/Shanghai'}

describe('独立加班服务端与迁移', () => {
  it('接受独立加班并规范内容，旧载荷默认为值班', () => {
    expect(parseRecord(payload)).toMatchObject({recordType:'overtime',workContent:'整理资料'})
    const {recordType: _type, workContent: _content, ...legacy} = {...payload, location:'art_center', baseMinutes:120}
    expect(parseRecord(legacy)).toMatchObject({recordType:'duty',workContent:null})
    for (const patch of [{workContent:''},{workContent:'字'.repeat(101)},{location:'art_center'},{baseMinutes:120},{overtimeMinutes:0},{overtimeMinutes:721},{recordType:'unknown'}]) {
      expect(() => parseRecord({...payload,...patch})).toThrow()
    }
  })
  it('新字段贯穿创建、幂等、修改、冲突、拉取、全量与删除', async () => {
    const db = createTestDatabase()
    await db.prepare("INSERT INTO users VALUES ('user-1','admin','hash','salt','now')").run()
    const create = parseOperations([{opId:'create-op-1',type:'create',record:payload}])
    const first = await applyOperations(db,'user-1',create)
    expect(first.results[0].record).toMatchObject({recordType:'overtime',workContent:'整理资料',location:null,baseMinutes:0,revision:1})
    expect(await applyOperations(db,'user-1',create)).toEqual(first)
    const edited = {...payload,workContent:'布置场地',overtimeMinutes:6}
    const update = parseOperations([{opId:'update-op-1',type:'update',recordId:payload.id,baseRevision:1,record:edited}])
    expect((await applyOperations(db,'user-1',update)).results[0].record).toMatchObject({workContent:'布置场地',overtimeMinutes:6,revision:2})
    const stale = parseOperations([{opId:'update-op-2',type:'update',recordId:payload.id,baseRevision:1,record:edited}])
    expect((await applyOperations(db,'user-1',stale)).results[0]).toMatchObject({status:'conflict',record:{recordType:'overtime',workContent:'布置场地'}})
    expect((await pull(db,'user-1',0,200)).changes[0].record).toMatchObject({recordType:'overtime',workContent:'布置场地'})
    expect((await full(db,'user-1')).records[0]).toMatchObject({location:null,baseMinutes:0,overtimeMinutes:6})
    const conversion = parseOperations([{opId:'convert-op-1',type:'update',recordId:payload.id,baseRevision:2,record:{...edited,recordType:'duty',workContent:null,location:'sutuo',baseMinutes:120}}])
    expect((await applyOperations(db,'user-1',conversion)).results[0].errorCode).toBe('RECORD_TYPE_IMMUTABLE')
    const deletion = parseOperations([{opId:'delete-op-1',type:'delete',recordId:payload.id,baseRevision:2}])
    expect((await applyOperations(db,'user-1',deletion)).results[0].record).toMatchObject({recordType:'overtime',workContent:'布置场地',revision:3})
    expect((await full(db,'user-1')).records[0].deletedAt).toBeTruthy()
  })
  it('真实 SQL 迁移保留旧记录、墓碑、日志游标、回执与索引', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(readFileSync('migrations/0001_init.sql','utf8'))
      db.exec("INSERT INTO users VALUES ('u','admin','hash','salt','now')")
      db.exec("INSERT INTO work_records VALUES ('r','u','2026-11-04','art_center','10:00',120,30,'Asia/Shanghai','created','updated',7,'deleted')")
      db.exec("INSERT INTO change_log VALUES (42,'u','r','delete','{}','now')")
      db.exec("INSERT INTO operation_receipts VALUES ('op','u','{}','now')")
      db.exec(readFileSync('migrations/0002_standalone_overtime.sql','utf8'))
      expect(db.prepare('SELECT * FROM work_records').get()).toMatchObject({id:'r',record_type:'duty',work_content:null,location:'art_center',revision:7,deleted_at:'deleted',created_at:'created',updated_at:'updated'})
      expect(db.prepare('SELECT seq FROM change_log').get()?.seq).toBe(42)
      expect(db.prepare('SELECT op_id FROM operation_receipts').get()?.op_id).toBe('op')
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('idx_wr_user_date','idx_wr_user_updated')").get()?.n).toBe(2)
      expect(() => db.exec("INSERT INTO work_records (id,user_id,work_date,record_type,work_content,location,start_time,base_minutes,overtime_minutes,timezone,created_at,updated_at) VALUES ('bad','u','2026-11-04','overtime','内容',NULL,'10:00',120,60,'Asia/Shanghai','now','now')")).toThrow()
    } finally { db.close() }
  })
})
