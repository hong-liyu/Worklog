# 当前状态

**版本** v1.1（纯前端 + Pages Functions + D1）
**日期** 2026-11-03

## 已完成

| 项 | 状态 |
|---|---|
| 首页月历、月份切换、整格着色、双地点混色 | 完成 |
| 月度累计工时与记录天数 | 完成 |
| 日期详情弹层、当天多条记录、按时间排序 | 完成 |
| 新增 / 编辑 / 删除，删除二次确认 | 完成 |
| 默认开始时间 = 当前整点，默认基础 2h，2h/3h 切换 | 完成 |
| 加班折叠输入、两位小数、上限 12h、结束时间联动与反算 | 完成 |
| 跨午夜记录与「次日」标识 | 完成 |
| IndexedDB 本地存储、离线增删改查 | 完成 |
| 操作队列、`opId` 幂等、`revision` 乐观锁、冲突重投 | 完成 |
| 增量同步（`seq` 游标分页）+ 全量重建 | 完成 |
| 登录、会话 Cookie、限流、同源校验 | 完成 |
| PWA manifest / Service Worker / 离线启动 / 更新提示 | 完成 |
| CSV 导出（BOM、排序、防公式注入） | 完成 |
| D1 迁移脚本、管理员初始化脚本 | 完成 |
| 自动化测试 70 个 | 通过 |

本地已验证：`wrangler pages dev` 起来后 health / 登录 / 推送 / 幂等重放 / 拉取 / 未授权 401 全部符合预期，前端 shell、manifest、sw.js 正常返回。

## 没做（有意为之）

- 部署到 Cloudflare：由你自己执行，步骤见 `docs/DEPLOY.md`，代码侧不需要再改。
- 定时自动备份 / Cron：Pages Functions 不支持 Cron，需要的话按 DEPLOY.md 末尾迁到 Workers。
- 多设备实时推送：只在打开、切回前台、恢复到在线时同步。
- 第三方登录、找回密码、多用户：单用户单账号。
- 深色模式、图表、年度报表：v1.0 就明确不做。

## 已知限制

1. **免费额度**：Workers 10 万请求/天、CPU 10ms/请求；D1 500 万行读、10 万行写/天。单用户远远够用，但一次拉几千条要按 200/页分页（已实现）。
2. **Time Travel 免费版只回滚 7 天**。更久的历史靠手工 `d1 export`。
3. **密码方案是妥协**：PBKDF2 在浏览器里跑（60 万轮），服务端只做一次 SHA-256。原因是 Workers 免费版 CPU 只有 10ms，服务端跑 Argon2id 会直接 1102。等价于把派生凭据当密码，靠 HTTPS + HttpOnly + SameSite + 登录限流兜底。
4. **冲突是本机优先**，不是逐字段合并。云端旧值留在 `change_log.snapshot`，没有 UI 回滚入口。
5. **推送写库分两步**：记录写入与 `change_log` 写入是两次 D1 调用（D1 无交互式事务），极端中断可能漏一条变更日志，兜底是「从云端重建」。
6. **浏览器清站点数据 = 本地未同步数据丢失**，技术上无法阻止。
7. **Pages 处于维护状态**，Cloudflare 主推 Workers + Static Assets，切换方式写在 DEPLOY.md。
8. **忘记密码**只能重跑 `scripts/create-user.ts`（会覆盖 hash，等同重置）。

## 与 design.md 的偏差（实现时做的简化）

- 没有单独抽 `BottomSheet.vue`：日详情、表单、设置各自内联遮罩层，共用同一套 `.sheet` 样式。少一层抽象，样式仍然改一处。
- 后端没有用 Hono，改成零依赖的纯函数路由（`server/app.ts`）。少一个运行时依赖，测试可以直接调 `handle(request, env)`。
- 不引入 vue-router / Pinia：只有一屏加三个弹层，`ref` + `reactive` 够用。
- 设置菜单比文档多一项「从云端重建本机数据」，作为恢复流程的入口。
- Cookie 的 `Secure` 只在 https 下设置，本地 http 调试时去掉，避免浏览器直接丢弃 Cookie。生产走 https，行为不变。
- 冲突重投最多 3 轮，仍未成功就停在「存在数据冲突」，等下次触发同步或手动重建。
- `change_log` 多存了一份变更后的快照 JSON 供追溯；拉取时仍然 JOIN 当前行，不做事件回放。
## 与上一版（work-log 目录）的关系

复用了：视觉与交互（calendar / form / 样式变量）、`domain.ts` 的纯函数思路、图标与 PWA 配置。

重写了：数据层（原方案是一堆历史迁移 + outbox）、同步（原方案是逐条 PUT/DELETE + 全量列表，无 revision、无幂等回执）、后端（原方案是 FastAPI + VPS SQLite，或 Pages 代理到 VPS）、认证（原方案最终取消了登录）。

新方案没有 VPS、没有反向代理、没有 `BACKEND_ORIGIN`，所有业务逻辑都在同一个 Pages 项目里。

## 环境相关（Windows）

`wrangler` 在部分机器的用户级 `%TEMP%` 下无法创建 workerd 的临时目录（`CreateDirectory: #5 拒绝访问`），表现为 `npm run db:migrate:local` / `dev:api` 直接以「Runtime failed to start」退出。

处理方式：所有 npm 脚本都经过 `scripts/wrangler.mjs`，启动前把 `TMP`/`TEMP` 指向项目内 `.tmp/`。这是环境适配，不是产品逻辑；Linux / macOS 上等价于不做任何处理。