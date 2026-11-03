import { describe, expect, it } from 'vitest'
import { deriveAuthHash, hashPassword, randomSalt, PBKDF2_ITERATIONS } from './password'

describe('口令派生', () => {
  it('同样的密码与用户名总是得到同样的 authHash', async () => {
    const first = await deriveAuthHash('hunter2hunter2', 'admin', 1000)
    const second = await deriveAuthHash('hunter2hunter2', 'admin', 1000)
    expect(first).toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9+/=]{40,48}$/)
  })

  it('用户名参与盐值，同一密码不同账号结果不同', async () => {
    const admin = await deriveAuthHash('hunter2hunter2', 'admin', 1000)
    const other = await deriveAuthHash('hunter2hunter2', 'sutuo', 1000)
    expect(admin).not.toBe(other)
  })

  it('库中保存的是加盐后的 SHA-256，不是 authHash 本身', async () => {
    const authHash = await deriveAuthHash('hunter2hunter2', 'admin', 1000)
    const salt = randomSalt()
    const stored = await hashPassword(authHash, salt)
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toContain(authHash)
    expect(await hashPassword(authHash, randomSalt())).not.toBe(stored)
  })

  it('默认迭代次数符合设计（60 万轮）', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000)
  })
})
