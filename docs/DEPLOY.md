# 部署到 Cloudflare Pages

不需要 VPS、不需要 Nginx、不需要域名。`*.pages.dev` 自带有效 HTTPS，PWA 可以直接安装。

## 前置

- 一个 Cloudflare 账号（免费版够用）。
- 本机已 `npm install`（wrangler 在 devDependencies 里）。
- `npx wrangler login` 授权过一次。

## 步骤

```bash
npm run build

# 1) 建生产库，把返回的 database_id 填进 wrangler.jsonc
npx wrangler d1 create worklog

# 2) 建表
npm run db:migrate:remote

# 3) 建管理员账号（交互式输入密码）
node scripts/create-user.ts --remote

# 4) 发布
npm run deploy
```

发布完成后 wrangler 会输出形如 `https://worklog-xxxx.pages.dev` 的地址。

第一次打开该地址时，浏览器会要求登录，用第 3 步设置的账号密码。

## 自定义域名（可选）

在 Pages 项目的 Custom domains 里添加域名即可，DNS 在同一个 Cloudflare 账号下会自动配证书。
代码里没有任何域名，换域名不需要改代码、不需要重新构建。

## 日常更新

```bash
npm test && npm run deploy
```

Pages 会保留旧版本，出问题可以在控制台回滚到上一个部署。Service Worker 用 `prompt` 模式：新版本下载完成后提示「有新版本可用」，不会打断正在填写的记录，也不会清空 IndexedDB。

## 配额提醒

| 项 | 免费额度 | 本项目的量级 |
|---|---|---|
| Workers 请求 | 10 万/天 | 一天几十次 |
| Workers CPU | 10 ms/请求 | 纯 SQL + JSON，几毫秒 |
| D1 读 / 写 | 500 万 / 10 万 行每天 | 一天几十行 |
| D1 存储 | 5 GB | 五年约 2 MB |

注意 CPU 10ms 是硬限制，所以密码哈希在浏览器端算（PBKDF2 60 万轮），服务端只做一次 SHA-256。不要把这个逻辑改回服务端。

## 可选：迁到 Workers + Static Assets

Pages 目前仍是维护状态，Cloudflare 新特性优先给 Workers。本项目后端就是一个 `handle(request, env)`，迁移成本很低：

1. 新建 `src/worker.ts`：`export default { fetch: (request, env) => handle(request, env) }`。
2. `wrangler.jsonc` 换成 `main` + `assets: { directory: "./dist", not_found_handling: "single-page-application" }`。
3. `npx wrangler deploy`。

顺带能加 Cron Trigger 做定时备份（Pages Functions 不支持 Cron）。
