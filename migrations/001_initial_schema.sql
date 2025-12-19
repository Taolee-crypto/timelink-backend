-- Users 테이블
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    tl_balance INTEGER DEFAULT 10000,
    total_earned INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    settings JSON DEFAULT '{
        "autoCharge": true,
        "chargeThreshold": 30,
        "defaultMultiplier": 1,
        "notifications": true
    }',
    email_verified BOOLEAN DEFAULT FALSE,
    verification_token TEXT,
    reset_token TEXT,
    reset_token_expiry DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- Music Files 테이블
CREATE TABLE IF NOT EXISTS music_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    tl_name TEXT NOT NULL,
    original_format TEXT NOT NULL,
    tl_format TEXT DEFAULT 'tl3',
    duration INTEGER NOT NULL, -- 초 단위
    file_size INTEGER NOT NULL, -- 바이트 단위
    multiplier INTEGER DEFAULT 1,
    charge_status INTEGER DEFAULT 0, -- 현재 충전량 (초)
    total_charged INTEGER DEFAULT 0, -- 총 충전량 (초)
    is_public BOOLEAN DEFAULT FALSE,
    copyright_type TEXT DEFAULT 'creator',
    royalty_percentage INTEGER DEFAULT 70,
    metadata JSON DEFAULT '{}',
    storage_path TEXT NOT NULL,
    encryption_key_hash TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_music_files_user_id ON music_files(user_id);
CREATE INDEX idx_music_files_status ON music_files(status);
CREATE INDEX idx_music_files_created_at ON music_files(created_at);

-- Video Files 테이블
CREATE TABLE IF NOT EXISTS video_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    tl_name TEXT NOT NULL,
    original_format TEXT NOT NULL,
    tl_format TEXT DEFAULT 'tlv3',
    duration INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    bitrate INTEGER,
    framerate REAL,
    multiplier INTEGER DEFAULT 1,
    charge_status INTEGER DEFAULT 0,
    total_charged INTEGER DEFAULT 0,
    quality TEXT DEFAULT '1080p',
    thumbnail_url TEXT,
    is_public BOOLEAN DEFAULT FALSE,
    metadata JSON DEFAULT '{}',
    storage_path TEXT NOT NULL,
    encryption_key_hash TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_files_user_id ON video_files(user_id);
CREATE INDEX idx_video_files_status ON video_files(status);

-- Charge Transactions 테이블
CREATE TABLE IF NOT EXISTS charge_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_type TEXT NOT NULL, -- 'music' 또는 'video'
    amount INTEGER NOT NULL, -- TL 단위
    seconds_added INTEGER NOT NULL, -- 추가된 초
    payment_method TEXT DEFAULT 'wallet',
    payment_status TEXT DEFAULT 'completed',
    transaction_hash TEXT,
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_charge_transactions_user_id ON charge_transactions(user_id);
CREATE INDEX idx_charge_transactions_file_id ON charge_transactions(file_id);
CREATE INDEX idx_charge_transactions_created_at ON charge_transactions(created_at);

-- Playback Sessions 테이블
CREATE TABLE IF NOT EXISTS playback_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_type TEXT NOT NULL,
    session_token TEXT NOT NULL,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    seconds_played INTEGER DEFAULT 0,
    tl_consumed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    client_ip TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_playback_sessions_user_id ON playback_sessions(user_id);
CREATE INDEX idx_playback_sessions_session_token ON playback_sessions(session_token);

-- Ad Views 테이블
CREATE TABLE IF NOT EXISTS ad_views (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ad_type TEXT NOT NULL, -- 'audio' 또는 'video'
    ad_duration INTEGER NOT NULL, -- 초 단위
    tl_rewarded INTEGER NOT NULL,
    completed BOOLEAN DEFAULT TRUE,
    advertiser TEXT,
    revenue_earned REAL DEFAULT 0.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_ad_views_user_id ON ad_views(user_id);
CREATE INDEX idx_ad_views_created_at ON ad_views(created_at);

-- Conversion Jobs 테이블
CREATE TABLE IF NOT EXISTS conversion_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_type TEXT NOT NULL,
    source_format TEXT NOT NULL,
    target_format TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    estimated_completion DATETIME,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversion_jobs_user_id ON conversion_jobs(user_id);
CREATE INDEX idx_conversion_jobs_status ON conversion_jobs(status);

-- Royalty Distributions 테이블
CREATE TABLE IF NOT EXISTS royalty_distributions (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    file_type TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    percentage INTEGER NOT NULL,
    transaction_id TEXT NOT NULL,
    distribution_type TEXT DEFAULT 'playback',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_royalty_distributions_creator_id ON royalty_distributions(creator_id);
CREATE INDEX idx_royalty_distributions_file_id ON royalty_distributions(file_id);

-- API Keys 테이블
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions JSON DEFAULT '["read"]',
    last_used DATETIME,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
