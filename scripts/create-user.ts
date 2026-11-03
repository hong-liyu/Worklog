/**
 * 初始化 / 重置管理员账号。
 *
 *   node scripts/create-user.ts --local  --username admin
 *   node scripts/create-user.ts --remote --username admin
 *
 * 密码通过交互式输入读取（不回显），也可以用 WORKLOG_PASSWORD 环境变量传入。
 * 只写入哈希，脚本本身不保存密码。
 *
 * 注意：authHash 在本地用 PBKDF2-SHA256(60 万轮) 算好后写入，
 * 与浏览器端登录时的算法完全一致，见 server/password.ts。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveAuthHash, hashPassword, randomSalt } from '../server/password.ts'

interface Options {
  username: string
  remote: boolean
}

function parseArgs(argv: string[]): Options {
  let username = 'admin'
  let remote = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--remote') remote = true
    else if (arg === '--local') remote = false
    else if (arg === '--username') username = argv[index + 1] ?? username
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
    throw new Error('用户名只能包含字母、数字、下划线、点和短横线，长度 1-64')
  }
  return { username, remote }
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    if (!stdin.isTTY) {
      const chunks: Buffer[] = []
      stdin.on('data', chunk => chunks.push(chunk as Buffer))
      stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8').trim()))
      stdin.resume()
      return
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolvePromise(value)
          return
        }
        if (char === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('已取消'))
          return
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.WORKLOG_PASSWORD
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) {
    throw new Error('当前不是交互式终端，请设置 WORKLOG_PASSWORD 环境变量后重试')
  }
  const first = await readHidden('设置登录密码: ')
  const second = await readHidden('再输入一次确认: ')
  if (first !== second) throw new Error('两次输入不一致')
  if (first.length < 8) throw new Error('密码至少 8 位')
  return first
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''")
}

async function main(): Promise<void> {
  const { username, remote } = parseArgs(process.argv.slice(2))
  const password = await readPassword()

  const authHash = await deriveAuthHash(password, username)
  const salt = randomSalt()
  const passwordHash = await hashPassword(authHash, salt)
  const now = new Date().toISOString()

  const sql = `INSERT INTO users (id, username, password_hash, password_salt, created_at)
VALUES ('${crypto.randomUUID()}', '${escapeSql(username)}', '${passwordHash}', '${salt}', '${now}')
ON CONFLICT(username) DO UPDATE SET
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt;`

  const tempDir = resolve('.tmp')
  const tempFile = resolve(tempDir, 'create-user.sql')
  mkdirSync(tempDir, { recursive: true })
  writeFileSync(tempFile, sql, 'utf8')

  const scope = remote ? '--remote' : '--local'
  console.log(`\n写入 ${remote ? '生产' : '本地'} D1: worklog（${scope}）...`)
  try {
    // 走 scripts/wrangler.mjs：它会先准备好可写的临时目录再启动 wrangler，
    // 避开 Windows 上 workerd 在 %TEMP% 建目录失败的问题。
    execFileSync(
      process.execPath,
      [resolve('scripts/wrangler.mjs'), 'd1', 'execute', 'worklog', scope, '--file', tempFile],
      { stdio: 'inherit' }
    )
    console.log(`\n完成。账号 ${username} 已就绪。`)
  } finally {
    // 只删含哈希的 SQL 文件；.tmp 是 wrangler/workerd 共用的临时目录，Windows 上
    // 运行时还占着句柄，整目录删除会 EPERM。
    rmSync(tempFile, { force: true })
  }
}

main().catch(error => {
  console.error(`\n失败: ${(error as Error).message}`)
  process.exitCode = 1
})
