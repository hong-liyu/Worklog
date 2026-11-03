/**
 * Minimal structural types for the D1 binding.
 *
 * 故意不依赖 @cloudflare/workers-types：Worker 运行时和本地测试用的
 * node:sqlite 适配器都实现同一套接口，类型只在这里声明一次。
 */

export interface D1Result<T = Record<string, unknown>> {
  success: boolean
  results: T[]
  meta: { changes: number }
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
}

export interface Env {
  DB: D1Database
}

export interface AuthUser {
  id: string
  username: string
  expiresAt: string
}
