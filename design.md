# WorkLog v1.1 — 纯前端 + Cloudflare Pages 轻量方案

- **文档版本：** 1.1（替代 v1.0 的 §2 / §8–§14 / §16.8 / §17–§19）
- **项目名称：** WorkLog（工时记录）
- **文档日期：** 2026-11-03
- **形态：** 单页 PWA（Vue 3 + Vite）+ Cloudflare Pages Functions + D1
- **运行成本：** Cloudflare 免费额度内；不需要域名、不需要 VPS、不需要信用卡

## 2026-11-04 功能增补（优先于下文原方案）

- 首页与日期详情各提供「值班记录」「加班记录」两个入口，详情入口沿用所选日期。
- 值班保留固定地点、1.5/2/2.5/3 小时基础工时（默认 2h，四项横向并排）和附加加班。独立加班不设地点与基础工时，工作内容必填且最多 100 字，时长默认 1h，支持两位小数并换算为 1—720 整数分钟。
- 时间双向联动、跨午夜归属开始日期；独立加班开始结束相同不能保存。编辑自动进入原类型表单，不允许转换类型。
- 日期改为周一开头的应用内月历，支持切月和今天；时间改为 24 小时点选小时及 00/15/30/45 分钟。历史或计算产生的特殊分钟原样保留。确定才应用，取消和关闭不改值，支持键盘与焦点返回。
- 仅独立加班的日期为淡紫色；和值班同日保留原值班底色并加紫点。值班内的附加加班不触发紫色。
- 月度总计包含两类全部工时，值班小计为基础工时，加班小计为附加加班与独立加班之和；总工时右侧显示按 25 元/小时计算的工资，以￥显示并保留两位小数，不再展示记录天数。
- 统一记录模型新增 `recordType: 'duty' | 'overtime'` 和 `workContent: string | null`；独立加班 `location=null`、`baseMinutes=0`，时长写入 `overtimeMinutes`。旧载荷缺少类型按值班解释。
- IndexedDB 从 v10 升级 v11，补齐旧记录类型且保留队列、游标。D1 通过新增迁移重建记录表并复制旧记录，保留 ID、版本号、删除状态、变更日志和回执。
- 同步接口路径不变，新字段贯穿推送、拉取、幂等、冲突重投、全量重建。CSV 保留原列并追加记录类型与工作内容，继续处理公式注入。
- 发布顺序：备份 → 数据库迁移 → 应用部署 → 各设备更新应用后使用新功能。旧版客户端不支持独立加班界面。

---

## 0. 结论先行

v1.0 里真正重的不是功能，是运维：Docker、Nginx、SQLite 文件、Cloudflare Tunnel、备份脚本、还得小心翼翼不碰 HY2。这些整体拿掉之后，P0 功能一条都不用砍。

| 层 | v1.0 | v1.1 |
|---|---|---|
| 前端 | Vue 3 + Vite + TS | 不变 |
| 本地库 | IndexedDB + Dexie | 不变 |
| 后端 | FastAPI + SQLAlchemy | Pages Functions（Hono 路由，单入口） |
| 数据库 | SQLite 文件 + 手写迁移 | D1（SQLite 兼容，托管） |
| 认证 | Argon2id + 会话表 | 客户端 PBKDF2 预哈希 + 服务端 SHA-256 |
| 部署 | VPS + Docker Compose + Nginx | `wrangler pages deploy` |
| HTTPS / 域名 | Cloudflare Tunnel + 自备域名 | 平台自带 `*.pages.dev` |
| 备份 | cron + `sqlite3 .backup` + 异地 | D1 Time Travel + 导出命令 + 应用内 JSON |
| 运维风险 | 不能碰 HY2 / 端口 / 防火墙 | 无服务器，零端口 |

**删除的章节：** v1.0 §13 全部（VPS 部署）、§13.4 Cloudflare Tunnel、§13.5 Caddy 替代方案、§13.6/13.7（容器持久化与日志轮转）、Docker Compose / nginx.conf / backup.sh、§16.8 VPS 测试、§0 约束 6（HY2）与约束 8（服务器权限）。

**容量估算（用来证明免费额度够用）：** 每天 3 条记录 × 5 年 ≈ 5,500 行，约 1.2 MB JSON。Workers 每天 10 万请求、D1 每天 500 万行读 / 10 万行写、5 GB 存储，对单用户是几百倍余量。

---

## 1. 三个必须先拍死的取舍

### 1.1 用 D1，不用 KV

KV 是最终一致的键值存储，没有排序、没有唯一约束、没有跨键原子写。而工时同步恰好三样都要：

- 同步游标必须单调（`change_log.seq`），KV 给不出可靠顺序；
- 请求去重必须依赖 `op_id` 唯一约束，KV 在写入传播完成前读到的是旧值，重试会重复建记录；
- 一次操作要同时写「记录 + 变更日志 + 回执」，需要原子性，KV 做不到。

所以 KV 在这个项目里没有位置。D1 一个库装下所有表。

### 1.2 Pages Functions，不用独立后端

前端和 API 同一个域名、同一个部署产物：`/api/*` 交给 Function，其余全部是静态文件。

好处是省掉 CORS、省掉反向代理、省掉一份部署配置，Cookie 天然同源。`_routes.json` 里只把 `/api/*` 列进 Function，其余请求不消耗 Worker 调用次数。

### 1.3 客户端预哈希，不用 Argon2id

Workers 免费版 CPU 上限是 **10 ms/请求**（[官方限额](https://developers.cloudflare.com/workers/platform/limits/)）。服务端跑 Argon2id 或 60 万轮 PBKDF2 会直接触发 1102 错误。

方案：

```
浏览器:  authHash = base64(PBKDF2-SHA256(密码, "worklog:" + 用户名, 600000 轮, 32B))
服务器:  password_hash = sha256hex(password_salt || authHash)     // salt 16B 随机，存库
登录:    比对一次 SHA-256（微秒级）
```

PBKDF2 的开销全部落在手机上，服务端只做一次哈希和一次查库。代价是 `authHash` 等价于口令派生凭据——泄漏它的后果和泄漏密码一样，靠 HTTPS + HttpOnly Cookie + 登录限流兜底。这是本项目唯一的密码学妥协，写在 §14。

---

## 2. 产品范围

### 2.1 P0 功能与落点

| P0 项 | 实现位置 |
|---|---|
| 当月日历 + 月份切换 | `components/MonthCalendar.vue` |
| 整格背景着色 / 双地点混色 | `lib/calendar.ts` |
| 月度工时累计 + 记录天数 | `lib/summary.ts` |
| 点日期看当天详情 | `components/DaySheet.vue` |
| 新增 / 编辑 / 删除 | `components/RecordForm.vue` + `db/repo.ts` |
| 开始时间、结束时间 | `lib/time.ts` |
| 默认基础 2h、1.5h/2h/2.5h/3h 快捷切换 | `RecordForm.vue` |
| 默认开始时间 = 当前整点 | `lib/time.ts` |
| 加班折叠数字输入 | `RecordForm.vue` |
| 结束时间自动计算与反算 | `lib/time.ts` |
| 本地离线存储 | Dexie |
| 云端同步 | `sync/*` + `functions/` |
| 登录验证 | `views/LoginView.vue` + `/api/v1/auth/*` |
| PWA 桌面安装 | `vite-plugin-pwa` |
| 手动导出 CSV | `lib/csv.ts`（纯前端生成） |
| 备份与恢复 | D1 Time Travel + `wrangler d1 export` + 应用内 JSON |
| 手机端适配 | `styles/*` |

### 2.2 v1.0 不实现（不变）

工资计算、GPS 签到、自动计时器、提醒推送、地点管理、多用户与后台、图表分析、年度报表、暗黑模式、日历第三方同步、备注/附件、APK 打包。

新增一条：**不做多设备实时协同**。同一账号两台设备靠同步合并，不做在线推送。

---

## 3. 架构

```text
Android 手机 / 桌面浏览器
        │
        ▼
  ┌──────────────────────────────┐
  │  Vue 3 PWA（同一个域名）      │
  │  月历 · 详情弹层 · 记录表单   │
  │                              │
  │  IndexedDB (Dexie)           │
  │   ├ records                   │
  │   ├ pendingOps                │
  │   └ syncMeta                 │
  └──────────────┬───────────────┘
                 │ fetch /api/v1/*
                 ▼
   Cloudflare Pages（HTTPS，*.pages.dev）
                 │
     ┌───────────┴────────────┐
     │                        │
  静态资源                 Pages Functions
  (dist/*, SW, icons)     (functions/api/[[path]].ts)
                               │
                               ▼
                          Hono 路由 + zod 校验
                               │
                               ▼
                             D1（SQLite）
                        users / sessions /
                        work_records / change_log /
                        operation_receipts / login_attempts
```

基本原则：

1. 渲染、日历、统计全在客户端，读本地优先。
2. 写操作先进 IndexedDB，再异步推服务器；网络失败不影响保存。
3. D1 是跨设备同步的权威数据源。
4. Service Worker 只缓存应用资源，不缓存业务数据。
5. 不需要域名：`https://<project>.pages.dev` 自带有效 HTTPS，满足 PWA 安装条件。

---

## 4. 数据模型

### 4.1 客户端记录

沿用 v1.0 §8.1，只加两个本地字段，不参与上传的权威判断：

```ts
type WorkLocation = 'art_center' | 'sutuo';

interface WorkRecord {
  id: string;                 // UUID v4，创建时生成，服务器不得替换
  workDate: string;           // YYYY-MM-DD
  location: WorkLocation;
  startTime: string;          // HH:mm
  baseMinutes: 120 | 180;
  overtimeMinutes: number;    // 非负整数
  timezone: string;           // 创建时设备 IANA 时区
  createdAt: string;          // UTC ISO
  updatedAt: string;          // UTC ISO
  revision: number;           // 服务器修订号，本地未同步的新记录为 0
  deletedAt: string | null;
}

// 仅本地：IndexedDB 里额外存 dirty 与冲突标记
type LocalRecord = WorkRecord & { dirty: boolean };
```

结束时间不落库，永远由 `workDate + startTime + baseMinutes + overtimeMinutes` 推导，避免三个字段互相矛盾。

### 4.2 IndexedDB（Dexie）

```ts
db.version(1).stores({
  records: 'id, workDate, location, [workDate+startTime], dirty',
  pendingOps: 'opId, recordId, createdAt',
  meta: 'key',   // syncCursor / lastSyncAt / lastLocation / lastLoginAt / deviceId
});
```

`pendingOps` 结构：

```ts
interface PendingOp {
  opId: string;                              // UUID，重试时必须复用
  type: 'create' | 'update' | 'delete';
  recordId: string;
  baseRevision: number;                      // create 为 0
  payload: WorkRecord | null;                // create/update 带完整目标状态；delete 为 null
  createdAt: string;
  attempts: number;
  lastError: string | null;
}
```

`update` 传完整目标状态而不是差异字段：两端都少一层合并逻辑，且天然幂等。

### 4.3 D1 表结构

`migrations/0001_init.sql`（`wrangler d1 migrations apply` 自动记录到 `d1_migrations` 表，可重复执行）：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- sha256hex(salt || authHash)
  password_salt TEXT NOT NULL,          -- 16 字节随机，hex
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256hex(token)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE work_records (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date        TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  location         TEXT NOT NULL CHECK (location IN ('art_center','sutuo')),
  start_time       TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  base_minutes     INTEGER NOT NULL CHECK (base_minutes IN (120,180)),
  overtime_minutes INTEGER NOT NULL CHECK (overtime_minutes BETWEEN 0 AND 720),
  timezone         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1,
  deleted_at       TEXT
);
CREATE INDEX idx_wr_user_date    ON work_records(user_id, work_date);
CREATE INDEX idx_wr_user_updated ON work_records(user_id, updated_at);

CREATE TABLE change_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('create','update','delete')),
  snapshot    TEXT,                      -- 变更后的记录 JSON，仅作追溯
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_cl_user_seq ON change_log(user_id, seq);

CREATE TABLE operation_receipts (
  op_id           TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  response_payload TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_or_user ON operation_receipts(user_id, created_at);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  ip_hash    TEXT,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_la ON login_attempts(username, created_at);
```

说明：

- `seq` 用 `AUTOINCREMENT`，保证单调不回收，游标不会因删除而回退。
- 删除是逻辑删除（`deleted_at`），行永远保留，保证增量同步能传播删除、也保证快照可追溯。
- `operation_receipts` 只增不减；数据量一个月也就几百行，量级可忽略。可每年手工清理一次（保留最近 180 天）。
- 时间字段统一存 UTC ISO 字符串，按字典序比较即等价时间序，不依赖 SQLite 日期函数。

---

## 5. 同步协议

### 5.1 本地写路径（先本地，后云端）

用户点保存时只有一个同步步骤：写 IndexedDB（记录 + 待同步操作，同一个 Dexie 事务），然后用响应式数据刷新界面，关闭弹层。网络请求在后台进行，失败只改状态文案。

队列规则（对应 v1.0 §9.4，简化后只有五条）：

| 场景 | 处理 |
|---|---|
| 新建 | 生成 `opId`，`baseRevision = 0`，入队 `create` |
| 改「还没同步过的新记录」 | 不新增操作，直接改写那条 `create` 的 `payload` |
| 删「还没同步过的新记录」 | 删除本地记录 + 移除该 `create`，**不发任何请求** |
| 改已同步记录 | 入队 `update`（已有未同步 update 则覆盖其 payload，`opId` 保持不变） |
| 删已同步记录 | 标记本地 `deletedAt` + 入队 `delete` |

一条记录最多同时存在 1 个待同步操作，天然没有顺序问题。

### 5.2 推送（幂等）

`POST /api/v1/sync/operations`，一次最多 100 个操作，按 `createdAt` 升序发。

服务端逐个处理：

1. 查 `operation_receipts`，命中则直接返回存下的结果（响应丢失后的重试走这条路径，不重复建记录）。
2. zod 校验业务字段；不合法返回 `validation_error`，该操作**出队并丢弃**（否则会永久卡住队列），同时记一条本地告警。
3. `create`：`INSERT ... ON CONFLICT(id) DO NOTHING`；若 id 已存在，视为成功，返回服务器现有记录，客户端以服务器版本为准。
4. `update` / `delete`：带守卫条件的单条 UPDATE。`meta.changes = 0` 时读出当前行判定：不存在 → `not_found`；`revision` 变了 → `conflict`（附服务器当前记录）。
5. 成功后在同一个 `env.DB.batch()` 里写 `change_log` + `operation_receipts`。

```sql
UPDATE work_records
   SET work_date=?, location=?, start_time=?, base_minutes=?, overtime_minutes=?,
       timezone=?, updated_at=?, revision=revision+1
 WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL;
```

### 5.3 冲突处理（相对 v1.0 简化）

v1.0 要求弹「使用云端版本 / 保留本地修改」二选一。日常只有两台设备、操作几乎即时推送，冲突窗口极小，所以改成：

- 默认**本机优先**：拿到服务器当前 `revision`，用新 `opId` 把本地期望状态重新提交一次（rebase），成功后队列清空。
- 界面上给一次非阻塞提示：`这条记录在其他设备上被修改过，已保留本机修改`。
- 云端旧版本留在 `change_log.snapshot` 里，需要时可以用 `wrangler d1 execute` 查回来，不做 UI。
- rebase 之后再冲突（几乎不可能）：停止重试，状态置为「存在数据冲突」，在设置菜单里显示，等用户手动点「从云端重建」。

这样既不静默丢数据，也不加一个没人会看的确认弹窗。

### 5.4 拉取（增量 + 全量兜底）

```sql
SELECT c.seq, r.*
  FROM change_log c
  JOIN work_records r ON r.id = c.record_id
 WHERE c.user_id = ? AND c.seq > ?
 ORDER BY c.seq ASC
 LIMIT ?;
```

- 每页 200 条，`cursor` = 本页最大 `seq`；`hasMore` = 是否满页，客户端循环拉到 `hasMore = false`。
- 同一条记录多次变更会返回多行，各行的 `r.*` 都是当前状态，客户端按 id upsert，重复无害。
- `deleted_at` 非空即删除；本地若该记录还有未同步操作，跳过不覆盖。
- 全量兜底：`GET /api/v1/sync/full` 返回全部记录（不分页，单用户数据量可接受），客户端清空本地后重建，游标取响应里的 `cursor`。这是恢复备份、`change_log` 异常、手动「从云端重建」的统一入口。

### 5.5 触发与退避

触发时机（对应 v1.0 §9.3，全部保留）：启动、新增后、修改后、删除后、`online` 事件、`visibilitychange` 转为可见、手动点击。

- 单飞锁：同一时刻只允许一个同步在跑，排队中的请求合并成一次。
- 失败退避：2s → 4s → 8s → 16s → 30s 封顶，最多 5 次；之后等下一次触发事件。
- 不依赖 Background Sync API。

### 5.6 状态展示

首页只在标题旁放一个小圆点 + 文案（不加大面板）：`已同步` / `等待同步` / `同步失败` / `存在数据冲突`。离线保存成功时 toast：`已保存到本地，联网后自动同步`。

---

## 6. API 规范

前缀 `/api/v1`，全部同源，全部要鉴权（除 login 与 health）。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/auth/login` | 登录，写 HttpOnly Cookie |
| POST | `/auth/logout` | 退出，删会话 |
| GET | `/auth/me` | 当前会话信息 |
| GET | `/sync?after=0&limit=200` | 拉增量 |
| GET | `/sync/full` | 全量重建 |
| POST | `/sync/operations` | 批量提交操作 |
| GET | `/health` | 健康检查 |

### 6.1 登录

```jsonc
// POST /api/v1/auth/login
{ "username": "admin", "authHash": "base64..." }
// 200
{ "user": { "username": "admin" }, "expiresAt": "2026-12-03T14:00:00Z" }
// 401
{ "error": { "code": "INVALID_CREDENTIALS", "message": "用户名或密码错误" } }
// 429
{ "error": { "code": "RATE_LIMITED", "message": "尝试过于频繁，请稍后再试" } }
```

### 6.2 推送

```jsonc
// POST /api/v1/sync/operations
{
  "operations": [
    {
      "opId": "3f1c...",
      "type": "create",
      "record": {
        "id": "9a2b...",
        "workDate": "2026-11-03",
        "location": "art_center",
        "startTime": "16:00",
        "baseMinutes": 120,
        "overtimeMinutes": 30,
        "timezone": "Asia/Shanghai",
        "createdAt": "2026-11-03T08:00:00.000Z",
        "updatedAt": "2026-11-03T08:00:00.000Z"
      }
    },
    { "opId": "7c9d...", "type": "update", "recordId": "aa11...", "baseRevision": 2, "record": { "...": "完整目标状态" } },
    { "opId": "b2e4...", "type": "delete", "recordId": "cc33...", "baseRevision": 1 }
  ]
}
```

```jsonc
// 200
{
  "cursor": 128,
  "results": [
    { "opId": "3f1c...", "status": "success", "revision": 1, "record": { "...": "服务器最终状态" } },
    { "opId": "7c9d...", "status": "conflict", "revision": 3, "record": { "...": "服务器当前状态" } },
    { "opId": "b2e4...", "status": "validation_error", "errorCode": "INVALID_TIME" }
  ]
}
```

`status` 只有三种：`success` / `conflict` / `validation_error`。

### 6.3 错误码

统一形状 `{ "error": { "code": "...", "message": "中文短句" } }`。

| code | HTTP | 场景 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 无会话或已过期 |
| `INVALID_CREDENTIALS` | 401 | 登录失败 |
| `RATE_LIMITED` | 429 | 登录过于频繁 |
| `VALIDATION_ERROR` | 400 | 请求体不合法 |
| `CONFLICT` | 409 | revision 不匹配（仅推送内层结果用，见上） |
| `NOT_FOUND` | 404 | 记录不存在 |
| `INTERNAL` | 500 | 未预期异常（日志里留 traceId，不回传细节） |

### 6.4 健康检查

`GET /api/v1/health` → `{ "ok": true, "version": "1.1.0", "time": "2026-11-03T14:00:00Z" }`。不查库、不暴露任何配置。

---

## 7. 认证与安全

### 7.1 会话

- 登录成功：`token = base64url(randomBytes(32))`，库里存 `sha256hex(token)`，Cookie：

```
Set-Cookie: wl_sid=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
```

- 每次请求：读 Cookie → `sha256hex` → 查 `sessions` → 校验 `expires_at > now` → 得到 `user_id`。
- 有效期 30 天固定，不做滑动续期。
- 退出：删 `sessions` 行 + 清 Cookie；前端同时清 IndexedDB（见 §7.4）。
- 令牌绝不进 localStorage / sessionStorage。

### 7.2 CSRF

不需要 CSRF token，两道就够了：

1. `SameSite=Lax` 阻止跨站 POST 携带 Cookie。
2. 所有非 GET 请求校验 `Origin` 头必须等于 `new URL(request.url).origin`，否则 403。

### 7.3 登录限流

`login_attempts` 表按 username 统计最近 15 分钟失败次数，超过 10 次直接 429（不查数据库用户）。成功登录后写入 `ok = 1` 并清理该用户 15 分钟前的记录。IP 只存 `sha256(ip).slice(0,16)`，不落原始 IP。

### 7.4 离线与退出

- 首次必须联网登录；之后允许离线打开（`meta.lastLoginAt` 存在即渲染本地数据）。
- 退出时若 `pendingOps` 非空，弹确认：`仍有 N 条未同步记录，退出将清除本机数据。` 用户确认后才清空 IndexedDB 并跳登录页。

### 7.5 密钥与配置

| 项 | 本地 | 生产 |
|---|---|---|
| D1 绑定 | `wrangler.jsonc` 的 `d1_databases` | 同文件，`database_id` 由 `wrangler d1 create` 生成 |
| 会话密钥 | 不需要（令牌是随机值，不做签名） | 同 |
| 管理员账号 | `scripts/create-user.mjs --local` | `scripts/create-user.mjs --remote` |

代码里不出现域名、IP、密码、密钥。`database_id` 是资源标识不是密钥，但仍由开发者本人生成后填入，不共享。

---

## 8. 前端实现

### 8.1 目录

```text
work-ui/
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── views/LoginView.vue
│   ├── components/
│   │   ├── AppHeader.vue          # 标题 + 同步圆点 + ⋮ 菜单
│   │   ├── MonthCalendar.vue      # 周一开头 7 列网格
│   │   ├── MonthSummary.vue       # 本月累计 / 记录天数
│   │   ├── DaySheet.vue           # 日期详情弹层
│   │   ├── RecordForm.vue         # 新增/编辑表单（同一个组件，props 区分）
│   │   ├── BottomSheet.vue        # 通用弹层壳：遮罩、90vh、下滑关闭
│   │   ├── SettingsSheet.vue      # 导出 CSV / 同步 / 退出
│   │   └── ConfirmDialog.vue
│   ├── lib/
│   │   ├── time.ts                # 纯时间计算
│   │   ├── calendar.ts            # 着色、月网格生成
│   │   ├── summary.ts             # 月度统计
│   │   ├── format.ts              # 小时格式化
│   │   ├── csv.ts                 # CSV 生成
│   │   ├── validate.ts            # 表单校验（与后端同规则）
│   │   └── id.ts                  # uuid / opId
│   ├── db/index.ts, repo.ts       # Dexie 封装
│   ├── sync/client.ts, queue.ts   # 同步
│   ├── stores/app.ts              # reactive 单例，不引入 Pinia
│   └── styles/tokens.css, base.css
├── functions/api/[[path]].ts      # 入口，只做转交给 server/app
├── functions/api/_lib/            # 后端源码（下划线开头不被路由）
│   ├── app.ts  auth.ts  db.ts  sync.ts  validate.ts  errors.ts  http.ts
├── migrations/0001_init.sql
├── scripts/create-user.mjs
├── tests/            # 前端单测
├── public/           # icons、_headers、_routes.json
├── wrangler.jsonc
├── vite.config.ts
└── package.json
```

不引入 vue-router（只有一屏 + 弹层），不引入 Pinia（一个 `reactive` 对象够）。

### 8.2 时间计算（`lib/time.ts`，全部为纯函数，必须有单测）

```ts
export const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export const toHHmm = (min: number) => {
  const v = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

// 结束时间 <= 开始时间时按次日解释
export const duration = (start: string, end: string) => {
  const d = toMinutes(end) - toMinutes(start);
  return d > 0 ? d : d + 1440;
};

export const isOvernight = (start: string, end: string) => toMinutes(end) <= toMinutes(start);

// 默认开始 = 当前整点（分钟/秒清零），每次打开新建弹窗时重新算
export const defaultStart = (now: Date) =>
  `${String(now.getHours()).padStart(2, '0')}:00`;

export const deriveEnd = (start: string, base: number, overtime: number) =>
  toHHmm(toMinutes(start) + base + overtime);

export const MAX_OVERTIME = 720;                 // 12h
export const maxTotal = (base: number) => base + MAX_OVERTIME;   // 840 / 900
```

边界约定：

- `end === start` → `duration = 1440`，随后被 `maxTotal` 拦下（840 或 900），报「总时长超出允许范围」。
- 跨午夜合法：`23:00 + 180 + 0 = 02:00`，`isOvernight` 为真，UI 显示 `次日 02:00`。
- 手改结束时间时反算：`overtime = duration(start, end) - base`，小于 0 直接提示并阻止保存，超过 720 同样阻止（不静默截断）。

### 8.3 日历与统计

```ts
// lib/calendar.ts
export type DayColor = 'empty' | 'art_center' | 'sutuo' | 'mixed';

export function dayColor(locs: Set<WorkLocation>): DayColor {
  if (locs.size === 0) return 'empty';
  if (locs.size === 2) return 'mixed';
  return locs.has('art_center') ? 'art_center' : 'sutuo';
}

// 周一为首列；只输出当月日期，前后补 null 占位
export function monthGrid(year: number, month: number): (number | null)[];
```

```ts
// lib/summary.ts
export function summarize(records: LocalRecord[], year: number, month: number) {
  const inMonth = records.filter(
    (r) => !r.deletedAt && r.workDate.startsWith(`${year}-${String(month).padStart(2, '0')}`),
  );
  return {
    totalMinutes: inMonth.reduce((s, r) => s + r.baseMinutes + r.overtimeMinutes, 0),
    workedDays: new Set(inMonth.map((r) => r.workDate)).size,
  };
}
```

月份归属只看 `workDate` 字符串，不经过 `Date` 对象，因此不受设备时区、夏令时、服务器 UTC 影响。月份切换只改 `viewYear/viewMonth`，不碰记录、不碰草稿。

### 8.4 视觉与交互要点

完整规范沿用 v1.0 §3–§7，这里只列落地时必须盯住的：

- 色板、字号、圆角、52px 主按钮、20px 边距、44px 触控区：照 v1.0 §3 定义成 CSS 变量。
- 日期格只显示数字；当前日用 `box-shadow: inset 0 0 0 1.5px var(--primary)` 画内描边，不遮背景色。
- 混色用 v1.0 §3.2 的 135deg 渐变。
- BottomSheet：`高度 ≤ 90dvh`、内部滚动、`padding-bottom: env(safe-area-inset-bottom)`、下滑关闭（`touchstart/touchmove` 判定 80px 阈值，仅在内容滚动到顶部时生效）、点遮罩关闭。
- 表单有未保存修改时关闭需要确认。
- 输入区滚动到可视范围：`input` 聚焦后 `scrollIntoView({ block: 'center' })`，避免软键盘压住保存按钮；加班输入 `inputmode="decimal"`。
- 动效 150–250ms，`@media (prefers-reduced-motion: reduce)` 下全部关掉。
- 日期选择用原生 `<input type="date">`，时间用 `<input type="time">`，不自己做滚轮。

### 8.5 CSV（纯前端）

```ts
const COLUMNS = ['日期', '地点', '开始时间', '结束时间', '基础工时(h)', '加班工时(h)', '总工时(h)'];

function cell(v: string) {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;          // 防公式注入
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
```

- 内容：全部未删除记录，按 `workDate` 升序、同日按 `startTime` 升序。
- 结束时间列输出 `YYYY-MM-DD HH:mm`（跨午夜时能看出日期，比只写 `HH:mm` 有用）；开始时间列仍是 `HH:mm`。
- 首部写 `\ufeff`（UTF-8 BOM），`Blob` 类型 `text/csv;charset=utf-8`，文件名 `worklog-YYYYMMDD.csv`。
- 数据源是 IndexedDB，所以离线也能导出，且与应用内统计必然一致。

### 8.6 PWA

- `vite-plugin-pwa`，`registerType: 'prompt'`，`workbox.navigateFallback: '/index.html'`，预缓存 `dist` 全部产物。
- `/api/**` 走 `NetworkOnly`，绝不进 Cache。
- 更新：检测到新版本 → 顶部条 `有新版本` + `立即更新`；若当时有弹层打开（正在填表单），只记一个待更新标记，等弹层关闭再提示。绝不自动 reload，绝不清理 IndexedDB。
- Manifest 按 v1.0 §12.1；图标准备 192/512 普通版与 512 maskable（四周留 20% 安全区），自己画简单日历图形，不用文字。

---

## 9. 部署（Cloudflare Pages）

### 9.1 前置

- 一个 Cloudflare 账号（免费）。
- Node 20+、`npm i -g wrangler`（或 `npx`）。
- 域名可选，非必需。

### 9.2 `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "worklog",
  "pages_build_output_dir": "./dist",
  "compatibility_date": "2026-11-03",
  "d1_databases": [
    { "binding": "DB", "database_name": "worklog", "database_id": "<wrangler d1 create 输出的 id>" }
  ]
}
```

### 9.3 首次部署

```bash
npm install
npx wrangler login
npx wrangler d1 create worklog                 # 把返回的 database_id 填进 wrangler.jsonc

npm run db:migrate:local                       # 本地库建表
node scripts/create-user.mjs --local           # 本地建管理员（交互式输入密码）

npm run dev                                    # ① Vite，5173，/api 代理到 8788
npm run dev:api                                # ② wrangler pages dev，8788

npm run build
npm run db:migrate:remote                      # 生产库建表
node scripts/create-user.mjs --remote          # 生产建管理员
npx wrangler pages deploy                      # 得到 https://worklog-xxx.pages.dev
```

`package.json` 脚本：

```json
{
  "dev": "vite",
  "dev:api": "wrangler pages dev",
  "build": "vue-tsc -b && vite build",
  "test": "vitest run",
  "test:api": "vitest run --config vitest.workers.config.ts",
  "db:migrate:local": "wrangler d1 migrations apply worklog --local",
  "db:migrate:remote": "wrangler d1 migrations apply worklog --remote",
  "deploy": "npm run build && wrangler pages deploy"
}
```

Vite 侧配 `server.proxy['/api'] = 'http://127.0.0.1:8788'`。本地开发完全不依赖 Cloudflare 账号：`wrangler pages dev` 用本地 Miniflare + 本地 D1 文件，登录、同步、迁移全部能跑。

### 9.4 静态资源与头

`public/_routes.json`（只有 `/api/*` 进 Function，省配额）：

```json
{ "version": 1, "include": ["/api/*"], "exclude": [] }
```

`public/_headers`：

```text
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: DENY
  Permissions-Policy: geolocation=(), microphone=(), camera=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache
```

### 9.5 域名

默认 `https://<project>.pages.dev` 就是有效 HTTPS，PWA 可安装，手机浏览器不会有证书警告。想用自有域名就在 Pages 项目里加 Custom domain，DNS 托管在同一账号下会自动配好证书；代码不用改，域名不出现在任何逻辑里。

### 9.6 可选：迁到 Workers + Static Assets

Cloudflare 现在主推 Workers + 静态资源，Pages 仍在维护但更新节奏慢。本项目后端就是一个 Hono app，切换成本很低：加一个 `src/worker.ts` 导出 `{ fetch: app.fetch }`，`wrangler.jsonc` 换成 `main` + `assets: { directory: "./dist", not_found_handling: "single-page-application" }`，`wrangler deploy`。顺带还能用 Cron Trigger 做自动备份。**v1.1 默认仍走 Pages**，此条仅作为退路记录。

---

## 10. 备份与恢复

三层，从轻到重：

| 层 | 手段 | 覆盖范围 | 说明 |
|---|---|---|---|
| 1 | D1 Time Travel | 免费版 7 天、付费版 30 天，精确到分钟 | 平台自动，无需开启 |
| 2 | `wrangler d1 export worklog --remote --output=worklog-YYYYMMDD.sql` | 完整数据库 | 建议每月一次，存本地/网盘 |
| 3 | 应用内「导出 JSON」 | 全部记录，可再导入 | 离线可用，换机时最方便 |

应用内额外提供「导出 CSV」给表格软件看。

**恢复 SOP：**

1. 停写：手机上不要操作，最好先退出登录（避免本地队列继续推送）。
2. 现网先备份一份：`wrangler d1 export worklog --remote --output=before-restore.sql`。
3. 恢复：`wrangler d1 time-travel restore worklog --timestamp=<unix秒>`，或对空库执行导入。
4. 重启验证：`curl https://<project>.pages.dev/api/v1/health`，登录后核对某一天记录与月累计。
5. 客户端处理：手机上点设置 →「从云端重建」，清空本地并按服务器数据重建，避免本地旧队列把已回滚的数据又推上去。
6. 若恢复点之后有本地记录想保留，先导出 JSON，重建后再导入（导入的记录 revision 归 0，作为新记录推送）。

不允许无提示地覆盖现有数据：每次恢复前先导出当前库，命令前后各存一份。

---

## 11. 测试

### 11.1 前端单测（Vitest，`tests/`）

时间计算，逐条对应 v1.0 §16.1：

| 用例 | 断言 |
|---|---|
| 16:15 新建 | `defaultStart` = `16:00`，`deriveEnd` = `18:00` |
| 16:00 新建 | `16:00` → `18:00` |
| 09:59 新建 | `09:00` → `11:00` |
| 23:45 新建 | `23:00` → `01:00`，`isOvernight` = true |
| 2h → 3h | 结束时间 +60min |
| 2h + 0.5h 加班 | 总 150min |
| 3h + 0.75h 加班 | 总 225min |
| 手改结束延后 30min | 反算 `overtimeMinutes` = 30 |
| 手改结束 < 基础工时 | 校验失败，`error = TOO_SHORT` |
| `overtimeHours` = -1 / `"abc"` / `1.234` | 全部拒绝；`1.5` 允许；`12` 允许；`12.5` 拒绝 |
| `round(0.75 × 60)` | 45，且累加 4 次不产生浮点误差 |

日历与统计，对应 v1.0 §16.2 / §16.3：着色六种组合、删除后降级、同日多地点、空月、2 月与闰年、12 月→次年 1 月、跨午夜记录归属起始日、同日三条记录 `workedDays = 1`。

另有：`formatHours`（120→`2h`、150→`2.5h`、135→`2.25h`、0→`0h`）、CSV 转义与公式注入前缀、`monthGrid` 行列数与周一开头、队列合并规则（改未同步记录只改 payload、删未同步记录不发请求）。

### 11.2 后端集成测试（`@cloudflare/vitest-pool-workers`，真实 workerd + 本地 D1）

- 登录成功 / 密码错 / 15 分钟内 11 次失败后 429
- 无 Cookie 访问 `/sync` → 401；伪造 token → 401
- `Origin` 不匹配的 POST → 403
- 创建 → 拉增量能看到 → 改 → 删除，`seq` 严格递增
- **幂等**：同一 `opId` 提交两次，第二次命中 receipt，`work_records` 只有一行，`change_log` 只有一条
- **冲突**：`baseRevision` 过期返回 `conflict` 且附服务器当前记录，服务器数据未被覆盖
- 跨用户隔离：A 的记录 B 查不到、改不了（直接构造第二个 user 行）
- 分页：造 250 条变更，两次拉完，游标连续无空洞
- 校验：`baseMinutes=100`、`location=xxx`、`overtime=-1`、`startTime=25:00` 全部 `validation_error`

### 11.3 人工验收（必须实际做一遍）

离线：登录 → 飞行模式 → 重开 PWA → 看月历 → 加一条 → 改一条 → 删一条 → 杀进程重开数据还在 → 恢复网络 → 自动同步 → 电脑上核对 `/sync/full` 结果一致。

PWA：Android Chrome 添加到主屏幕、图标正常、standalone 启动、断网启动、发新版本后 IndexedDB 数据不丢。

### 11.4 不做

不写 E2E 自动化的浏览器矩阵，不测 Firefox/Safari（v1.0 也就要求 Android Chrome）。

---

## 12. 开发阶段

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| 一 | 脚手架、视觉变量、月历、统计卡、两个弹层、表单联动、时间纯函数 | `npm run dev` 用 mock 数据，界面与交互全可点，时间单测全绿 |
| 二 | Dexie、本地 CRUD、离线启动、PWA manifest/SW、CSV 导出 | **不启动后端也能完整记账**，断网刷新数据仍在 |
| 三 | Functions + D1 + 认证 + 同步（推送/拉取/幂等/冲突）+ 集成测试 | 本地 `wrangler pages dev` 双端联调通过，两台浏览器同步一致 |
| 四 | 部署 Pages、手机安装、真实网络下的离线/同步验收 | 手机桌面图标可用，`*.pages.dev` 上数据一致 |
| 五 | 文档（DEPLOY / USER_GUIDE / RECOVERY）、备份恢复演练、已知问题清单 | 按文档从零复现一次部署 |

阶段二结束就已经是「可用的产品」，阶段三之后才是「可换机的产品」。这个顺序保证任何时候中断都不至于交不出东西。

---

## 13. 交付物与验收

### 13.1 交付物

1. 完整源码（前端 + Functions）。
2. `package.json` + lockfile，`npm ci` 可复现。
3. 开发命令（`dev` / `dev:api` / `test` / `test:api`）与生产命令（`build` / `deploy`）。
4. `wrangler.jsonc`（不含真实 `database_id`，用占位）+ `.dev.vars.example`（本项目实际不需要任何密钥，保留文件说明这一点）。
5. `migrations/0001_init.sql` + `scripts/create-user.mjs`。
6. 测试用例与最近一次运行结果。
7. CSV 导出、JSON 导出/导入、备份恢复文档。
8. Android PWA 安装说明 + 用户使用说明。
9. 当前已知问题与未完成事项（见 §14）。
10. 部署前需要你确认的信息（见 §15）。

### 13.2 验收清单

- [ ] 首页月历符合清爽极简风格，日期格只有数字
- [ ] 艺术中心浅蓝、素拓浅绿、同日双地点混色
- [ ] 点日期看当天详情，一天多条记录按开始时间排序
- [ ] 新建默认开始时间 = 当前整点（16:15 → 16:00），默认基础 2h
- [ ] 2h / 3h 切换后结束时间正确联动
- [ ] 加班默认折叠，展开为自由数字输入，上限 12h，两位小数
- [ ] 手改结束时间能反算加班；不足基础工时时阻止保存
- [ ] 跨午夜记录显示「次日」
- [ ] 增 / 改 / 删即时更新月历与统计
- [ ] 断网可增改删查；联网自动同步；失败不丢数据
- [ ] 同一 `opId` 重试不产生第二条记录
- [ ] 两台设备修改同一条记录时 revision 冲突被识别，不静默覆盖
- [ ] Android 桌面图标可启动，离线可启动
- [ ] 数据可导出 CSV、可备份、可按文档恢复
- [ ] 全部 P0 测试通过，部署文档可从零复现

---

## 14. 已知限制（诚实列表）

1. **免费额度是硬约束。** Workers 10 万请求/日、CPU 10 ms/请求；D1 500 万行读、10 万行写/日。单用户日常用量约为上限的千分之一，但一次拉几千条的全量同步要按 200 条/页分页，别做成一次查全表。
2. **Time Travel 免费版只保留 7 天**（付费 30 天）。想要更长历史，靠每月手工 `d1 export`，这是刻意接受的运维成本。
3. **没有定时自动备份。** Pages Functions 不支持 Cron Trigger。要自动化就得按 §9.6 迁到 Workers 再加 Cron + R2，属于可选增强，不列进 v1.1。
4. **密码学妥协。** 用客户端 PBKDF2 预哈希 + 服务端单次 SHA-256 替代 Argon2id，原因见 §1.3。若哪天升到 Workers 付费版（CPU 5 分钟），可以改回服务端 Argon2id。
5. **冲突策略是本机优先，不是逐字段合并。** 提示 + 服务端快照留档，不提供「选用云端版本」的对话框。真要找回云端版本需要 CLI。
6. **推送写库分两步。** 记录 UPDATE 与 `change_log` 写入是两次 D1 调用（D1 没有交互式事务），极小概率下中间失败会造成一条变更没进日志。兜底是「从云端重建」，不做分布式事务的过度设计。
7. **Pages 是维护状态。** Cloudflare 现在主推 Workers + Static Assets，Pages 还能正常用，但新特性优先给 Workers。切换脚本已在 §9.6 说明。
8. **单用户单账号。** 忘记密码只能跑 `create-user.mjs` 重置，没有找回流程。
9. **浏览器清站点数据 = 本地数据丢失。** 未同步的记录会一起没。界面在有待同步数据时会提示，但技术上无法阻止用户清缓存。
10. **不做多设备实时协同。** 设备 A 改了，设备 B 要等它自己触发同步才看得到，没有推送通道。

---

## 15. 部署前需要你确认的事

1. **Cloudflare 账号**：有没有？免费版即可。部署方式选 Git 集成（推代码自动构建）还是本地 `wrangler pages deploy` 直接上传？
2. **域名**：用 `*.pages.dev` 就行，还是要绑自己的域名？（要绑的话域名 DNS 必须在 Cloudflare 上）
3. **密码方案**：接受 §1.3 的客户端预哈希妥协吗？不接受的话只有两条路——升 Workers 付费版，或者砍掉登录（只靠域名保密，不推荐）。
4. **账号名**：默认 `admin`，要不要换？

这四项都不影响我先写阶段一到阶段三的代码：本地开发用 `wrangler pages dev` + 本地 D1，不需要账号也不需要域名。

---

## 附：v1.0 → v1.1 章节映射

| v1.0 | v1.1 处理 |
|---|---|
| §1 产品定义 | 保留，`§2` |
| §2.1 技术栈 | FastAPI/SQLAlchemy/Nginx/Docker/Tunnel 替换为 Pages Functions/D1，见 `§0` |
| §3 视觉设计 | 原样保留（本文 `§8.4` 只列落地要点） |
| §4 首页 | 原样保留 |
| §5–§7 弹层/表单/增删改 | 原样保留 |
| §8 数据模型 | 客户端不变；表结构改 D1 方言，`§4` |
| §9 离线与同步 | 保留骨架，冲突处理简化，`§5` |
| §10 API | 路径与语义保留，删除多用户痕迹，`§6` |
| §11 认证安全 | Argon2id → 预哈希，其余保留，`§7` |
| §12 PWA | 原样保留 |
| §13 VPS 部署 | **删除**，替换为 `§9` |
| §14 备份导出 | 备份方式全部替换，导出保留并改为纯前端，`§10` |
| §15 手机端交互 | 原样保留 |
| §16 测试 | §16.1–16.7 保留，§16.8 删除，`§11` |
| §17–§19 阶段与验收 | 重排为 5 阶段，`§12` `§13` |
