CREATE TABLE IF NOT EXISTS line_owner (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS line_orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
INSERT OR IGNORE INTO line_orgs VALUES ('baiqi','百麒','{"id":"baiqi","name":"百麒","kind":"內部","mark":"百","en":"INTERNAL · COMPANY","contact":"尚未提供","role":"公司內部","manager":"尚未提供","contract":"尚未提供","memo":"公司內部紀錄","prices":[]}');
CREATE TABLE IF NOT EXISTS line_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_event_user_time ON line_events(user_id,created_at);
CREATE TABLE IF NOT EXISTS line_drafts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, source_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_draft_user_time ON line_drafts(user_id,created_at);
CREATE TABLE IF NOT EXISTS line_saved (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS line_auth_attempts (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
