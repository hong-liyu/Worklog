/**
 * 批量创建 / 重置用户。
 *
 *   node scripts/bulk-users.ts --remote --file .tmp/users.csv
 *
 * users.csv 每行 `用户名,密码`，支持 # 注释和空行：
 *
 *   张三,his-password-123
 *   李四,another-password-456
 *
 * 用户名规则与单用户脚本一致（字母数字下划线点短横线，1-64 位），
 * 密码至少 8 位。已存在的用户名会被重置密码（数据不受影响）。
 * 所有用户在一次 D1 执行里写入，失败即整体不生效。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveAuthHash, hashPassword, randomSalt } from '../server/password.ts'

interface Entry {
  username: string
  password: string
}

interface Options {
  file: string
  remote: boolean
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/

function parseArgs(argv: string[]): Options {
  let file = '.tmp/users.csv'
  let remote = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--remote') remote = true
    else if (arg === '--local') remote = false
    else if (arg === '--file') file = argv[index + 1] ?? file
  }
  return { file: resolve(file), remote }
}

function parseCsv(text: string): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()

  text
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim()
      if (!line || line.startsWith('#')) return

      const comma = line.indexOf(',')
      if (comma < 0) {
        throw new Error(`第 ${index + 1} 行缺少逗号，格式应为 用户名,密码`)
      }

      const username = line.slice(0, comma).trim()
      const password = line.slice(comma + 1).trim()

      if (!USERNAME_RE.test(username)) {
        throw new Error(`第 ${index + 1} 行用户名不合法：${username}`)
      }
      if (password.length < 8) {
        throw new Error(`第 ${index + 1} 行密码少于 8 位：${username}`)
      }
      if (seen.has(username)) {
        throw new Error(`用户名重复：${username}`)
      }

      seen.add(username)
      entries.push({ username, password })
    })

  if (entries.length === 0) throw new Error('文件里没有任何有效行')
  return entries
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''")
}

async function main(): Promise<void> {
  const { file, remote } = parseArgs(process.argv.slice(2))
  if (!existsSync(file)) throw new Error(`找不到用户文件：${file}`)

  const entries = parseCsv(readFileSync(file, 'utf8'))
  const scope = remote ? '--remote' : '--local'
  console.log(`\n读取 ${entries.length} 个用户，写入${remote ? '生产' : '本地'} D1（${scope}）...\n`)

  const statements: string[] = []
  for (const entry of entries) {
    const authHash = await deriveAuthHash(entry.password, entry.username)
    const salt = randomSalt()
    const passwordHash = await hashPassword(authHash, salt)
    const now = new Date().toISOString()
    statements.push(
      `INSERT INTO users (id, username, password_hash, password_salt, created_at)
VALUES ('${crypto.randomUUID()}', '${escapeSql(entry.username)}', '${passwordHash}', '${salt}', '${now}')
ON CONFLICT(username) DO UPDATE SET
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt;`
    )
  }

  const tempDir = resolve('.tmp')
  const tempFile = resolve(tempDir, 'bulk-users.sql')
  mkdirSync(tempDir, { recursive: true })
  writeFileSync(tempFile, statements.join('\n'), 'utf8')

  try {
    execFileSync(
      process.execPath,
      [resolve('scripts/wrangler.mjs'), 'd1', 'execute', 'worklog', scope, '--file', tempFile],
      { stdio: 'inherit' }
    )
    console.log(`\n完成。${entries.length} 个账号已就绪：`)
    for (const entry of entries) console.log(`  · ${entry.username}`)
    console.log('\n密码没有回显也不需要回显，按你自己填的那份分发给每个人。')
  } finally {
    // 只删含哈希的 SQL 文件，.tmp 是 wrangler 共用的临时目录
    rmSync(tempFile, { force: true })
  }
}

main().catch(error => {
  console.error(`\n失败: ${(error as Error).message}`)
  process.exitCode = 1
})
