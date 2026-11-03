import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result } from './types'

/**
 * 测试用 D1 适配器：用 node:sqlite 跑真实的建表语句和真实 SQL，
 * 这样 CHECK 约束、索引、AUTOINCREMENT 游标、ON CONFLICT 都能被真正验证。
 */
export function createTestDatabase(schemaPath = resolve('migrations/0001_init.sql')): D1Database {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(readFileSync(schemaPath, 'utf8'))

  const prepare = (sql: string): D1PreparedStatement => {
    let params: never[] = []
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        params = values as never[]
        return statement
      },
      async first<T>(column?: string) {
        const row = database.prepare(sql).get(...params) as Record<string, unknown> | undefined
        if (!row) return null
        return (column === undefined ? row : row[column]) as T
      },
      async all<T>() {
        const rows = database.prepare(sql).all(...params) as Record<string, unknown>[]
        return { success: true, results: rows as T[], meta: { changes: 0 } }
      },
      async run() {
        const outcome = database.prepare(sql).run(...params)
        return { success: true, results: [], meta: { changes: Number(outcome.changes) } }
      }
    }
    return statement
  }

  return {
    prepare,
    async batch(statements) {
      database.exec('BEGIN')
      try {
        const results: D1Result[] = []
        for (const statement of statements) results.push(await statement.run())
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
  }
}
