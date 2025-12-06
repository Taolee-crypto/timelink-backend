-- TimeLink 데이터베이스 스키마
-- Cloudflare D1 데이터베이스용 SQL

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    avatar_url TEXT,
    bio TEXT,
    balance DECIMAL(10, 2) DEFAULT 0.00,
    total_earnings DECIMAL(10, 2) DEFAULT 0.00,
    total_spent DECIMAL(10, 2) DEFAULT 0.00,
    role TEXT DEFAULT 'user', -- 'user', 'creator', 'admin'
    is_verified BOOLEAN DEFAULT FALSE,
    social_links JSON, -- JSON 형식으로 소셜 링크 저장
    settings JSON DEFAULT '{}', -- 사용자 설정
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

-- 콘텐츠 테이블
CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_url TEXT NOT NULL, -- Cloudflare R2나 다른 스토리지 URL
    thumbnail_url TEXT,
    file_type TEXT NOT NULL, -- 'audio', 'video', 'image', 'document'
    file_size INTEGER, -- 파일 크기 (바이트)
    duration INTEGER, -- 오디오/비디오 길이 (초)
    category TEXT DEFAULT 'general',
    tags TEXT, -- 콤마로 구분된 태그들
    price DECIMAL(10, 2) DEFAULT 0.00,
    is_free BOOLEAN DEFAULT FALSE,
    download_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft', -- 'draft', 'active', 'hidden', 'deleted'
    metadata JSON DEFAULT '{}', -- 추가 메타데이터
    copyright_info TEXT, -- 저작권 정보
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 스튜디오 프로젝트 테이블
CREATE TABLE IF NOT EXISTS studio_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    project_data JSON NOT NULL, -- 프로젝트 상태 저장 (트랙, 이펙트 등)
    thumbnail_url TEXT,
    duration INTEGER DEFAULT 0,
    is_public BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'draft', -- 'draft', 'published', 'archived'
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 마켓플레이스 아이템 테이블
CREATE TABLE IF NOT EXISTS market_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    original_price DECIMAL(10, 2),
    currency TEXT DEFAULT 'TLT', -- TimeLink Token
    royalty_percentage DECIMAL(5, 2) DEFAULT 0.00, -- 원작자 로열티 비율
    is_auction BOOLEAN DEFAULT FALSE,
    auction_end_time TIMESTAMP,
    current_bid DECIMAL(10, 2),
    highest_bidder_id INTEGER,
    total_sales INTEGER DEFAULT 0,
    revenue DECIMAL(10, 2) DEFAULT 0.00,
    status TEXT DEFAULT 'active', -- 'active', 'sold', 'expired', 'cancelled'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
    FOREIGN KEY (seller_id) REFERENCES users(id),
    FOREIGN KEY (highest_bidder_id) REFERENCES users(id)
);

-- 거래 기록 테이블
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL, -- 'deposit', 'withdraw', 'purchase', 'sale', 'royalty'
    amount DECIMAL(10, 2) NOT NULL,
    currency TEXT DEFAULT 'TLT',
    description TEXT,
    content_id INTEGER,
    market_item_id INTEGER,
    status TEXT DEFAULT 'completed', -- 'pending', 'completed', 'failed', 'refunded'
    metadata JSON DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (content_id) REFERENCES content(id),
    FOREIGN KEY (market_item_id) REFERENCES market_items(id)
);

-- 저작권 요청 테이블
CREATE TABLE IF NOT EXISTS copyright_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    request_type TEXT NOT NULL, -- 'verification', 'claim', 'dispute'
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'under_review'
    evidence_urls JSON, -- 증거 파일 URL들
    description TEXT,
    decision TEXT, -- 'approved', 'rejected'
    decision_reason TEXT,
    decided_by INTEGER, -- 관리자 ID
    decided_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (content_id) REFERENCES content(id),
    FOREIGN KEY (decided_by) REFERENCES users(id)
);

-- 튜브 (비디오 플랫폼) 관련 테이블
CREATE TABLE IF NOT EXISTS tube_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    category TEXT,
    privacy TEXT DEFAULT 'public', -- 'public', 'private', 'unlisted'
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    dislike_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    duration INTEGER,
    thumbnail_url TEXT,
    video_url TEXT NOT NULL,
    status TEXT DEFAULT 'published', -- 'draft', 'published', 'hidden'
    published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES tube_channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tube_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    channel_name TEXT NOT NULL UNIQUE,
    description TEXT,
    avatar_url TEXT,
    banner_url TEXT,
    subscriber_count INTEGER DEFAULT 0,
    video_count INTEGER DEFAULT 0,
    total_views INTEGER DEFAULT 0,
    is_verified BOOLEAN DEFAULT FALSE,
    social_links JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tube_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES tube_channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tube_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    parent_comment_id INTEGER, -- 대댓글 기능
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    is_edited BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES tube_videos(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_comment_id) REFERENCES tube_comments(id) ON DELETE CASCADE
);

-- 구매 기록 테이블
CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    market_item_id INTEGER,
    price DECIMAL(10, 2) NOT NULL,
    currency TEXT DEFAULT 'TLT',
    royalty_paid DECIMAL(10, 2) DEFAULT 0.00, -- 원작자에게 지급된 로열티
    license_type TEXT DEFAULT 'standard', -- 'standard', 'commercial', 'exclusive'
    download_count INTEGER DEFAULT 0,
    last_download_at TIMESTAMP,
    is_refunded BOOLEAN DEFAULT FALSE,
    refund_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (buyer_id) REFERENCES users(id),
    FOREIGN KEY (content_id) REFERENCES content(id),
    FOREIGN KEY (market_item_id) REFERENCES market_items(id)
);

-- 좋아요 테이블
CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, content_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE
);

-- 북마크/컬렉션 테이블
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    collection_name TEXT DEFAULT 'default',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, content_id, collection_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE
);

-- 알림 테이블
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- 'purchase', 'sale', 'like', 'comment', 'system'
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    metadata JSON DEFAULT '{}', -- 관련 데이터 (content_id, sender_id 등)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- API 키 테이블 (결제 웹훅 등에 사용)
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    secret_key TEXT,
    permissions JSON DEFAULT '["read"]',
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 인덱스 생성 (성능 최적화)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_content_user_id ON content(user_id);
CREATE INDEX IF NOT EXISTS idx_content_status ON content(status);
CREATE INDEX IF NOT EXISTS idx_content_category ON content(category);
CREATE INDEX IF NOT EXISTS idx_market_items_content_id ON market_items(content_id);
CREATE INDEX IF NOT EXISTS idx_market_items_seller_id ON market_items(seller_id);
CREATE INDEX IF NOT EXISTS idx_market_items_status ON market_items(status);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_tube_videos_channel_id ON tube_videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_tube_videos_published_at ON tube_videos(published_at);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer_id ON purchases(buyer_id);
CREATE INDEX IF NOT EXISTS idx_purchases_content_id ON purchases(content_id);
CREATE INDEX IF NOT EXISTS idx_likes_content_id ON likes(content_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);

-- 트리거 예시: 사용자 잔액 업데이트 시 updated_at 갱신
CREATE TRIGGER IF NOT EXISTS update_users_updated_at 
AFTER UPDATE ON users 
BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- 트리거: 콘텐츠 업데이트 시 updated_at 갱신
CREATE TRIGGER IF NOT EXISTS update_content_updated_at 
AFTER UPDATE ON content 
BEGIN
    UPDATE content SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- 초기 관리자 계정 생성 (비밀번호: admin123 - 실제 운영시 변경 필요)
INSERT OR IGNORE INTO users (email, password, username, role, is_verified) 
VALUES ('admin@timelink.com', 'admin123', 'admin', 'admin', TRUE);
