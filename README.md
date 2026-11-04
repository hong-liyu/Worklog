# WorkLog v1.1

极简个人工时记录 PWA。打开就能记，记完就忘掉它。

- 前端：Vue 3 + Vite + TypeScript，纯单页，无路由。
- 本地库：IndexedDB（Dexie），所有写操作先落本地。
- 后端：Cloudflare Pages Functions（`functions/api/[[path]].ts`），零框架依赖。
- 数据库：Cloudflare D1（SQLite），存用户、会话、记录、变更日志、操作回执。
- 同步：本地优先 + 操作队列 + `opId` 幂等 + `revision` 乐观锁 + `seq` 增量游标。
- 形态：PWA，可添加到 Android 桌面，离线可用。

现已支持独立加班（填写工作内容与时长），日期和时间使用应用内选择面板；升级时先迁移数据库，再部署应用，详见部署文档。

需求基准见 [`design.md`](design.md)（v1.1，替代 v1.0 的部署与后端章节）。

## 目录

```text
├── src/                  前端
│   ├── domain.ts         时间/着色/统计/CSV 纯函数（全部有单测）
│   ├── storage.ts        Dexie：records / ops / meta
│   ├── sync.ts           推送、拉取、冲突重投、全量重建
│   ├── api.ts            同源请求封装 + 口令派生
│   ├── App.vue           单页装配
│   ├── components/       月历、日详情、记录表单、设置
│   └── views/LoginView.vue
├── server/               Pages Functions 的业务实现（纯函数，可单测）
│   ├── app.ts            路由
│   ├── auth.ts           登录、会话、限流
│   ├── records.ts        同步写入 / 增量拉取 / 全量
│   ├── validate.ts       服务端校验（信任边界）
│   ├── password.ts       PBKDF2 派生 + SHA-256
│   └── testing.ts        测试用 D1 适配器（node:sqlite）
├── functions/api/[[path]].ts   Pages Functions 入口
├── migrations/0001_init.sql    D1 建表
├── scripts/create-user.ts      初始化/重置管理员账号
├── public/                     icons、_headers、_routes.json
└── docs/                       部署、使用、恢复说明
```

## 本地跑起来

```bash
npm install

# 1) 建本地 D1 库 + 建管理员账号（交互式输入密码，至少 8 位）
npm run setup:local
#    非交互环境：WORKLOG_PASSWORD=xxx npm run setup:local

# 2) 两个终端
npm run dev:api     # wrangler pages dev，http://127.0.0.1:8788
npm run dev         # vite，http://127.0.0.1:5173（/api 已代理到 8788）
```

第一次打开需要登录；登录成功后断开网络，刷新页面仍然能看记录、能增删改，联网后自动同步。

本地数据落在 `.wrangler/state/v3/d1`，删掉它等于重置本地数据库。

## 检查

```bash
npm test         # 109 个测试：时间计算、日历着色、统计、CSV、队列、同步、API、幂等、冲突、鉴权
npm run typecheck
npm run build    # 产出 dist/（含 sw.js 与 manifest）
```

## 数据怎么走

1. 保存时先写 IndexedDB（记录 + 一条待同步操作），界面立刻更新。
2. 后台把操作批量推到 `/api/v1/sync/operations`，服务器按 `opId` 去重后写 D1。
3. 服务器每次变更写一条 `change_log`，客户端用 `seq` 游标增量拉取。
4. 网络失败只影响同步状态文案，不影响本地保存。

冲突策略是「本机优先 + 提示 + 服务端保留快照」：两台设备改同一条记录时，本机版本会以服务器最新 revision 重新提交，云端旧值留在 `change_log.snapshot` 里可查。

## 文档

- [部署到 Cloudflare](docs/DEPLOY.md)
- [使用说明](docs/USER_GUIDE.md)
- [备份与恢复](docs/RECOVERY.md)
- [当前状态与已知限制](docs/STATUS.md)
- [同步失败定位](docs/SYNC_TROUBLESHOOTING.md)

## 常见问题

**Windows 上 wrangler 报 `miniflare-email-store ... CreateDirectory: #5 拒绝访问`**

workerd 在用户级 `%TEMP%` 下建不了临时目录，wrangler 会以「Runtime failed to start」退出，跟项目代码无关。

本项目所有 npm 脚本都已通过 `scripts/wrangler.mjs` 包装，它先把 `TMP`/`TEMP` 指到项目内的 `.tmp/` 再启动 wrangler，所以 `npm run setup:local` / `npm run dev:api` / `npm run deploy` 正常执行即可。

如果你绕开脚本直接调 `npx wrangler`，需要自己设一次：

```powershell
New-Item -ItemType Directory .tmp -Force | Out-Null
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
npx wrangler pages dev
```

**登录后立刻弹回登录页**

本地走 http，Cookie 不带 `Secure`（脚本按协议判断）。如果仍被丢弃，检查浏览器是否开了「阻止 Cookie / 仅 HTTPS」之类的设置，或者改用 `http://127.0.0.1:8788`（`npm run dev:api`）而不是 5173。