/** Read-only preflight: never deploy application code ahead of required D1 migrations. */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const scope = args.includes('--local') ? '--local' : '--remote'
const persistIndex = args.indexOf('--persist-to')
const persistArgs = persistIndex >= 0 && args[persistIndex + 1]
  ? ['--persist-to', args[persistIndex + 1]] : []

try {
  const required = readdirSync(resolve(root, 'migrations')).filter(file => /^\d+.*\.sql$/.test(file)).sort()
  const output = execFileSync(process.execPath, [resolve(root, 'scripts/wrangler.mjs'),
    'd1', 'execute', 'worklog', scope, ...persistArgs, '--json',
    '--command', 'SELECT name FROM d1_migrations ORDER BY id'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const result = JSON.parse(output)
  if (!Array.isArray(result) || result.some(entry => !entry.success || !Array.isArray(entry.results))) {
    throw new Error('无法读取数据库迁移状态')
  }
  const applied = new Set(result.flatMap(entry => entry.results.map(row => row.name)))
  const pending = required.filter(file => !applied.has(file))
  if (pending.length) {
    console.error(`数据库尚未升级，已阻止部署：\n${pending.map(file => `  ${file}`).join('\n')}`)
    console.error(`请先运行 npm run db:migrate:${scope === '--local' ? 'local' : 'remote'}，再重新部署。`)
    process.exitCode = 1
  } else {
    console.log(`数据库迁移检查通过（${scope}，${required.length} 份迁移）。`)
  }
} catch {
  console.error('无法确认数据库已升级，已阻止部署。请检查 Cloudflare 登录、网络和数据库初始化情况。')
  process.exitCode = 1
}
