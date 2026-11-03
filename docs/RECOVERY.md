# 备份与恢复

数据只有一份权威副本：Cloudflare D1。本地 IndexedDB 只是缓存 + 待发送队列。

## 三层备份

| 层 | 手段 | 覆盖 | 说明 |
|---|---|---|---|
| 1 | D1 Time Travel | 免费版回滚窗口 7 天，精确到分钟 | 平台自动，不用开启 |
| 2 | `wrangler d1 export` | 完整数据库 SQL 文件 | 建议每月一次，存本地或网盘 |
| 3 | 应用内「导出 CSV」 | 全部未删除记录 | 给表格软件看，也能当人工核对底稿 |

```bash
# 导出（存到当前目录）
npx wrangler d1 export worklog --remote --output worklog-$(date +%Y%m%d).sql
```

免费版 Time Travel 只有 7 天，**超过 7 天的历史只能靠你自己导出的 SQL 文件**。这是刻意的取舍：不加定时任务，就保留每月一次的手工动作。

## 恢复：误删/误改（7 天内）

```bash
# 1) 先确认要回到的时间点（UTC 时间或 Unix 秒）
npx wrangler d1 time-travel info worklog --timestamp="2026-11-03T12:00:00+00:00"

# 2) 恢复前，把当前库也导一份，避免恢复错了没有退路
npx wrangler d1 export worklog --remote --output before-restore.sql

# 3) 恢复（会就地覆盖）
npx wrangler d1 time-travel restore worklog --timestamp=1762200000
```

恢复命令会返回一个「撤销用」的 bookmark，记下来，恢复错了可以再回到恢复前的状态。

## 恢复：整库重建（换账号 / 数据库损坏）

```bash
npx wrangler d1 create worklog-new         # 拿到新的 database_id
# 把 database_id 填进 wrangler.jsonc

npx wrangler d1 execute worklog-new --remote --file=worklog-20261103.sql
npm run db:migrate:remote                  # 若导出文件不含 d1_migrations 记录
node scripts/create-user.ts --remote       # 库里没有用户时重新建号
npm run deploy
```

## 恢复之后的客户端处理（关键）

服务器回滚以后，手机上的本地缓存可能比服务器「新」。这时不要让手机继续推旧队列：

1. 在手机上打开设置 →「从云端重建本机数据」。
2. 确认后本地缓存会被清空并从服务器重新拉取，待同步队列一并清掉。
3. 如果回滚前有还没同步的记录想保留，先在旧手机上导出 CSV 留底，重建后再手动补录。

不做这一步的后果：旧队列会把回滚掉的数据又推回服务器。

## 确认恢复成功

- `curl https://<你的域名>/api/v1/health` 返回 `{"ok":true,...}`。
- 手机登录后，某一天的记录条数与月累计与恢复目标一致。
- 抽查一条跨午夜记录，结束时间显示 `次日`。

## 导出文件怎么读

- `wrangler d1 export` 产出的是标准 SQLite SQL，可以直接 `sqlite3` 打开，也可以再导入任何 SQLite 环境。
- 应用内 CSV 是 UTF-8 BOM + 全字段双引号，日期升序、同日按开始时间升序，跨午夜的结束时间写成 `YYYY-MM-DD HH:mm`。
