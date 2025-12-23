-- TimeLink 데이터베이스 스키마

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(100) NOT NULL,
    real_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    verification_token VARCHAR(255),
    email_verified BOOLEAN DEFAULT FALSE,
    tl_balance INTEGER DEFAULT 10000,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 음악 앨범 테이블
CREATE TABLE IF NOT EXISTS music_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title VARCHAR(255) NOT NULL,
    artist VARCHAR(255) NOT NULL,
    description TEXT,
    cover_image_url VARCHAR(500),
    duration_minutes INTEGER,
    track_count INTEGER,
    price_per_minute INTEGER NOT NULL,
    original_price INTEGER,
    category VARCHAR(50),
    is_featured BOOLEAN DEFAULT FALSE,
    is_exclusive BOOLEAN DEFAULT FALSE,
    play_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 트랙 테이블
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    duration_seconds INTEGER NOT NULL,
    track_number INTEGER,
    file_url VARCHAR(500),
    play_count INTEGER DEFAULT 0,
    FOREIGN KEY (album_id) REFERENCES music_albums(id) ON DELETE CASCADE
);

-- 스트리밍 히스토리 테이블
CREATE TABLE IF NOT EXISTS streaming_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    album_id INTEGER NOT NULL,
    track_id INTEGER,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP,
    duration_seconds INTEGER,
    tl_spent INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (album_id) REFERENCES music_albums(id),
    FOREIGN KEY (track_id) REFERENCES tracks(id)
);

-- TL 거래 내역 테이블
CREATE TABLE IF NOT EXISTS tl_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    transaction_type VARCHAR(50) NOT NULL, -- 'deposit', 'withdrawal', 'purchase', 'streaming'
    description TEXT,
    balance_after INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 사용자 선호도 테이블
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,
    language VARCHAR(10) DEFAULT 'ko',
    theme VARCHAR(20) DEFAULT 'dark',
    autoplay_enabled BOOLEAN DEFAULT TRUE,
    quality_preference VARCHAR(20) DEFAULT 'high',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 인덱스 생성
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_music_albums_category ON music_albums(category);
CREATE INDEX idx_streaming_history_user ON streaming_history(user_id);
CREATE INDEX idx_tl_transactions_user ON tl_transactions(user_id);
CREATE INDEX idx_streaming_history_time ON streaming_history(start_time);

-- 트리거: 사용자 업데이트 시간 자동 갱신
CREATE TRIGGER IF NOT EXISTS update_users_timestamp
AFTER UPDATE ON users
BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- 트리거: 선호도 업데이트 시간 자동 갱신
CREATE TRIGGER IF NOT EXISTS update_preferences_timestamp
AFTER UPDATE ON user_preferences
BEGIN
    UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
END;

-- 샘플 데이터 삽입
INSERT OR IGNORE INTO music_albums 
(title, artist, description, cover_image_url, duration_minutes, track_count, price_per_minute, original_price, category, is_featured, is_exclusive) VALUES
('Quantum Beats', 'Neural Nexus', '양자 컴퓨팅에서 영감을 받은 일렉트로닉 앨범', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80', 45, 12, 5, 8, 'Electronic', TRUE, FALSE),
('Digital Dreams', 'Cyber Symphony', '디지털 시대의 꿈을 음악으로 표현', 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80', 60, 15, 7, 10, 'Ambient', TRUE, FALSE),
('Neo Seoul Nights', 'Hologram', '미래 서울의 밤을 담은 시티팝 앨범', 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80', 50, 10, 6, 9, 'City Pop', TRUE, TRUE),
('Crypto Waves', 'Blockchain Beats', '블록체인 기술에서 영감을 받은 실험적 음악', 'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80', 40, 8, 8, 12, 'Experimental', FALSE, TRUE);

-- 트랙 샘플 데이터
INSERT OR IGNORE INTO tracks (album_id, title, duration_seconds, track_number) VALUES
(1, 'Quantum Entanglement', 240, 1),
(1, 'Superposition', 210, 2),
(1, 'Qubit Dance', 195, 3),
(2, 'Digital Dawn', 180, 1),
(2, 'Binary Dreams', 220, 2),
(3, 'Neon Streets', 245, 1),
(3, 'Hologram Love', 210, 2),
(4, 'Blockchain Pulse', 230, 1),
(4, 'Decentralized Rhythm', 205, 2);

-- 샘플 사용자 (테스트용)
INSERT OR IGNORE INTO users (email, password_hash, nickname, real_name, email_verified) VALUES
('test@timelink.com', '$2b$10$YourTestHashHere', '테스트유저', '홍길동', TRUE);
