-- 초기 테이블 생성
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    email_verified BOOLEAN DEFAULT FALSE,
    verification_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tl_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    original_filename TEXT NOT NULL,
    tl3_filename TEXT,
    file_size INTEGER,
    uploader_type TEXT DEFAULT 'owner',
    marketplace_status TEXT DEFAULT 'none',
    market_registered_at DATETIME,
    queue_registered_at DATETIME,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
