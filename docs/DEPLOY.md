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

## 日常改动流程

```bash
npm run dev          # 改代码，5173 热更新
npm test             # 逻辑改动必跑（时间计算 / 统计 / 同步）
npm run deploy       # 自动执行 test + build + 上传
npm run deploy:quick # 只改样式文案时用，跳过测试
```

部署用的是直接上传（Direct Upload），`git push` 不会自动上线，必须手动 deploy。

手机端入口是项目域名 `https://<project>.pages.dev`，不要用 `wrangler` 输出里带 hash 的单次部署别名（证书不覆盖，会报「不受支持的协议」）。

应用更新走 Service Worker 的 prompt 模式：打开后顶部出现「有新版本可用」，点重新加载才切换；更新不会清空 IndexedDB 里的本地数据。看不到提示就从最近任务里彻底关掉再开。

## 改动数据库结构

1. 先导出备份：`npx wrangler d1 export worklog --remote --output=before.sql`
2. 新增 `migrations/0002_xxx.sql`，不要改已应用过的文件
3. `npm run db:migrate:local` 和 `npm run db:migrate:remote`
4. 顺序优先选向后兼容：先加表/加列 → 部署兼容代码 → 确认无误后再清理旧结构
5. SQLite 只支持有限 ALTER：加列可以，删列/改类型要新建表再搬数据
## 多人使用

一个人一套账号，数据按 `user_id` 隔离。添加用户有两种方式。

单个：

```bash
node scripts/create-user.ts --remote --username zhangsan
```

批量：把名单写进 `.tmp/users.csv`（该目录已在 `.gitignore`，不会提交），每行 `用户名,密码`，支持 `#` 注释：

```csv
# 同事
zhangsan,his-password-123
lisi,her-password-456
```

```bash
npm run users:bulk -- --remote --file .tmp/users.csv
```

- 用户名只允许字母、数字、`_`、`.`、`-`，1–64 位；密码至少 8 位。
- 用户名已存在时**重置密码**，不会重复创建，也不动已有记录。
- 整份名单在一次 D1 执行里写入，任何一行不合法就整体不生效。
- 脚本不回显密码，按你自己那份名单分发即可。

每个用户在各自设备上打开同一个网址登录，看到的只有自己的数据。注意：同一台手机切换账号时，退出登录会清空本机缓存，重登需要重新拉一次全量数据。
## 独立加班版本升级（2026-11-04）

此次新增 `migrations/0002_standalone_overtime.sql`，不要重置数据库或修改已应用的 `0001_init.sql`。

1. 先导出远端数据库备份，妥善保管其中的账号和记录数据。
2. 本地验证新迁移和应用后，执行 `npm run db:migrate:remote` 应用新迁移。
3. 再执行 `npm run deploy` 部署前后端。此次功能开发没有代为执行远端迁移或线上发布。
4. 各设备在更新提示中点「重新加载」，更新后再新增、编辑独立加班记录。

迁移会重建记录表以调整校验约束，并复制旧记录，原有 ID、版本号和删除状态不变；变更日志、操作回执、用户与会话不动。旧记录统一标为值班。浏览器本地升级同样保留未同步操作和同步游标。

迁移先行后，原有值班载荷仍可提交；旧版界面无法正确展示独立加班，不应在旧版设备上操作新类型记录。

## 基础工时选项更新

新选项为 1.5h、2h、2.5h，默认 2h。此次新增 `migrations/0003_duty_duration_options.sql`，部署前先执行 `npm run db:migrate:remote`，再执行 `npm run deploy`。单独部署前端而没有迁移数据库，会导致 1.5h / 2.5h 记录无法写入云端。

迁移保留全部现有值班与独立加班记录、原有时长、ID、版本号和删除状态；历史 3h 及旧客户端载荷继续兼容，新建表单仅提供三个新选项。

## 部署前的数据库检查与同步诊断

`npm run deploy` 和 `npm run deploy:quick` 现在都会先只读检查远端数据库迁移状态。缺少迁移时直接停止，不自动升级数据库；按提示执行 `npm run db:migrate:remote` 后再部署。`npm run db:check:remote` 可单独检查。

同步失败时让同学更新页面，在设置中复制/下载同步诊断，按请求编号对应 Pages Functions 日志。完整步骤见 `docs/SYNC_TROUBLESHOOTING.md`。
