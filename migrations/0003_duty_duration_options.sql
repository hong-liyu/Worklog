-- Add 1.5h / 2.5h duty durations. Keep 3h for historical records and older clients.
CREATE TABLE work_records_v3 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  record_type TEXT NOT NULL DEFAULT 'duty' CHECK (record_type IN ('duty', 'overtime')),
  work_content TEXT,
  location TEXT,
  start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  base_minutes INTEGER NOT NULL,
  overtime_minutes INTEGER NOT NULL CHECK (overtime_minutes BETWEEN 0 AND 720),
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  CHECK (
    (record_type = 'duty' AND location IS NOT NULL AND location IN ('art_center', 'sutuo')
      AND base_minutes IN (90, 120, 150, 180) AND work_content IS NULL)
    OR
    (record_type = 'overtime' AND location IS NULL AND base_minutes = 0
      AND overtime_minutes BETWEEN 1 AND 720 AND work_content IS NOT NULL
      AND length(trim(work_content)) BETWEEN 1 AND 100)
  )
);

INSERT INTO work_records_v3
  (id, user_id, work_date, record_type, work_content, location, start_time,
   base_minutes, overtime_minutes, timezone, created_at, updated_at, revision, deleted_at)
SELECT id, user_id, work_date, record_type, work_content, location, start_time,
       base_minutes, overtime_minutes, timezone, created_at, updated_at, revision, deleted_at
FROM work_records;

DROP TABLE work_records;
ALTER TABLE work_records_v3 RENAME TO work_records;
CREATE INDEX idx_wr_user_date ON work_records(user_id, work_date);
CREATE INDEX idx_wr_user_updated ON work_records(user_id, updated_at);
