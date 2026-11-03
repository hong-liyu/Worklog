/**
 * wrangler 启动包装器。
 *
 * 为什么需要它：部分 Windows 机器上 workerd 无法在用户级 %TEMP% 里创建
 * 临时目录（`CreateDirectory: #5 拒绝访问`，Miniflare 的 miniflare-email-store），
 * wrangler 会直接以「Runtime failed to start」退出。
 * 这里把 TMP/TEMP 指到项目内的 .tmp 再启动 wrangler，绕开用户级 Temp 的问题。
 *
 * 用法：node scripts/wrangler.mjs <wrangler 参数...>
 *   node scripts/wrangler.mjs pages dev
 *   node scripts/wrangler.mjs d1 migrations apply worklog --local
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = resolve(root, '.tmp')
mkdirSync(tempDir, { recursive: true })

const env = { ...process.env, TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir }

const wranglerBin = resolve(root, 'node_modules/wrangler/bin/wrangler.js')
const child = spawn(process.execPath, [wranglerBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})

child.on('error', error => {
  console.error(`无法启动 wrangler: ${error.message}`)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 1))
