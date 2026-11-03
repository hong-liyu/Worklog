import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RecordInput, WorkRecord } from './domain'
import {
  allRecords,
  applyOperationSuccess,
  clearLocalData,
  db,
  deleteRecord,
  getOp,
  importRecords,
  mergeServerRecords,
  pendingOps,
  rebaseOperation,
  saveRecord,
  type LocalRecord
} from './storage'

const input: RecordInput = {
  workDate: '2026-11-03',
  location: 'art_center',
  startTime: '16:00',
  baseMinutes: 120,
  overtimeMinutes: 0,
  timezone: 'Asia/Shanghai'
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('本地写入与待同步队列', () => {
  it('新记录产生 create 操作，revision 从 0 开始', async () => {
    const record = await saveRecord(input)
    expect(record.revision).toBe(0)
    expect(record.dirty).toBe(1)

    const ops = await pendingOps()
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ recordId: record.id, type: 'create', baseRevision: 0 })
    expect(ops[0]?.opId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('反复修改同一条记录不会堆积操作，opId 保持不变', async () => {
    const first = await saveRecord(input)
    const opId = (await pendingOps())[0]?.opId
    const second = await saveRecord({ ...input, overtimeMinutes: 30 }, first)
    const third = await saveRecord({ ...input, location: 'sutuo', overtimeMinutes: 45 }, second)

    const ops = await pendingOps()
    expect(ops).toHaveLength(1)
    expect(ops[0]?.opId).toBe(opId)
    expect(third.id).toBe(first.id)

    const stored = await db.records.get(first.id)
    expect(stored?.location).toBe('sutuo')
    expect(stored?.overtimeMinutes).toBe(45)
  })

  it('删除尚未同步的新记录时直接取消，不发任何请求', async () => {
    const record = await saveRecord(input)
    await deleteRecord(record)
    expect(await allRecords()).toHaveLength(0)
    expect(await pendingOps()).toHaveLength(0)
  })

  it('删除已同步记录会生成 delete 操作并带上服务器版本', async () => {
    const record = await saveRecord(input)
    const op = (await pendingOps())[0]!
    const synced: LocalRecord = { ...record, revision: 3, dirty: 0 }
    await applyOperationSuccess(op, synced)

    const stored = await db.records.get(record.id)
    expect(stored?.revision).toBe(3)
    expect(stored?.dirty).toBe(0)

    await deleteRecord(stored!)
    expect(await allRecords()).toHaveLength(0)
    const ops = await pendingOps()
    expect(ops[0]).toMatchObject({ type: 'delete', baseRevision: 3 })
  })
})

describe('服务器返回值合并', () => {
  it('推送成功后清空操作并采用服务器 revision', async () => {
    const record = await saveRecord(input)
    const op = (await pendingOps())[0]!
    const wire: WorkRecord = { ...record, revision: 1, updatedAt: new Date().toISOString() }
    await applyOperationSuccess(op, wire)

    expect(await pendingOps()).toHaveLength(0)
    const stored = await db.records.get(record.id)
    expect(stored).toMatchObject({ revision: 1, dirty: 0 })
  })

  it('有本地修改的记录不会被拉取数据覆盖', async () => {
    const record = await saveRecord(input)
    await mergeServerRecords([{ ...record, revision: 9, location: 'sutuo' }])
    const stored = await db.records.get(record.id)
    expect(stored?.location).toBe('art_center')
    expect(stored?.revision).toBe(0)
  })

  it('拉取到墓碑会删除本地记录', async () => {
    const record = await saveRecord(input)
    const op = (await pendingOps())[0]!
    await applyOperationSuccess(op, { ...record, revision: 1 })

    await mergeServerRecords([{ ...record, revision: 2, deletedAt: '2026-11-04T00:00:00.000Z' }])
    expect(await db.records.get(record.id)).toBeUndefined()
  })

  it('冲突后 rebase 换新 opId 并改用服务器 revision', async () => {
    const record = await saveRecord(input)
    const before = (await pendingOps())[0]!
    await rebaseOperation(before, 7)

    const after = (await pendingOps())[0]!
    expect(after.opId).not.toBe(before.opId)
    expect(after.baseRevision).toBe(7)
    expect(after.lastError).toBe('conflict')
    expect(await getOp(record.id)).toMatchObject({ baseRevision: 7 })
  })

  it('导入的记录以新记录身份重新入队', async () => {
    const record = await saveRecord(input)
    const op = (await pendingOps())[0]!
    await applyOperationSuccess(op, { ...record, revision: 4 })
    await clearLocalData()

    const imported = await importRecords([{ ...record, revision: 4 }])
    expect(imported).toBe(1)
    const ops = await pendingOps()
    expect(ops[0]).toMatchObject({ type: 'create', baseRevision: 0 })
    const stored = await db.records.get(record.id)
    expect(stored?.revision).toBe(0)
    expect(stored?.dirty).toBe(1)
  })

  it('退出登录清空记录、队列与元数据', async () => {
    await saveRecord(input)
    await clearLocalData()
    expect(await allRecords()).toHaveLength(0)
    expect(await pendingOps()).toHaveLength(0)
    expect(await db.meta.count()).toBe(0)
  })
})
