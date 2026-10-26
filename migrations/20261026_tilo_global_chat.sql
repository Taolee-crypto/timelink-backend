-- Shared global TILO radio chat and active member presence (all stations).
CREATE TABLE IF NOT EXISTS tilo_global_presence (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tilo_global_presence_seen ON tilo_global_presence(last_seen_at);
CREATE TABLE IF NOT EXISTS tilo_global_chat (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 500),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tilo_global_chat_created ON tilo_global_chat(id DESC);
