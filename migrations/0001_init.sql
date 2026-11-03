-- WorkLog v1.1 初始结构（Cloudflare D1 / SQLite 方言）
-- 由 wrangler d1 migrations apply 记录到 d1_migrations，可重复执行不会重复建表。
--
-- 注意：这里不写 PRAGMA foreign_keys。D1 的所有查询都在隐式事务里执行，
-- 外键始终处于开启状态且不允许在迁移中修改；写了反而可能让远端迁移报错。
-- 本地测试用 node:sqlite，默认外键是关的，由 server/testing.ts 单独打开。

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- sha256(salt:authHash)
  password_salt TEXT NOT NULL,          -- 16 字节随机，hex
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- sha256(token)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,             -- UTC ISO
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS work_records (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date        TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  location         TEXT NOT NULL CHECK (location IN ('art_center', 'sutuo')),
  start_time       TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  base_minutes     INTEGER NOT NULL CHECK (base_minutes IN (120, 180)),
  overtime_minutes INTEGER NOT NULL CHECK (overtime_minutes BETWEEN 0 AND 720),
  timezone         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wr_user_date    ON work_records(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_wr_user_updated ON work_records(user_id, updated_at);

CREATE TABLE IF NOT EXISTS change_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'delete')),
  snapshot    TEXT,                     -- 变更后的记录 JSON，仅作追溯
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cl_user_seq ON change_log(user_id, seq);

CREATE TABLE IF NOT EXISTS operation_receipts (
  op_id           TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  response_payload TEXT NOT NULL,       -- 该 opId 的最终处理结果 JSON
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_or_user ON operation_receipts(user_id, created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  ip_hash    TEXT,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_la ON login_attempts(username, created_at);
