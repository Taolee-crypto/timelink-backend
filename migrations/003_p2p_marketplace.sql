-- P2P 마켓플레이스 테이블 추가
-- 2024년 12월 14일

-- 1. 음원 마켓플레이스 테이블
CREATE TABLE IF NOT EXISTS music_market (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    uploader_type TEXT NOT NULL, -- 'creator' or 'owner'
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    price_tl INTEGER DEFAULT 100, -- TL 가격
    revenue_split TEXT DEFAULT '30:70:0', -- 플랫폼:업로더:저작권자
    status TEXT DEFAULT 'active', -- active, paused, sold_out
    views INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,
    earnings_total INTEGER DEFAULT 0,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (file_id) REFERENCES tl_files(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 2. P2P 대기열 테이블
CREATE TABLE IF NOT EXISTS p2p_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    uploader_type TEXT DEFAULT 'owner',
    user_id INTEGER NOT NULL,
    owner_name TEXT NOT NULL,
    purchase_source TEXT,
    queue_position INTEGER,
    status TEXT DEFAULT 'pending', -- pending, verifying, approved, rejected
    verification_started_at DATETIME,
    verification_completed_at DATETIME,
    copyright_owner_found BOOLEAN DEFAULT FALSE,
    copyright_owner_email TEXT,
    estimated_wait_days INTEGER DEFAULT 3,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (file_id) REFERENCES tl_files(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 3. 저작권 증명 자료 테이블
CREATE TABLE IF NOT EXISTS copyright_proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL,
    proof_type TEXT NOT NULL, -- copyright, contract, receipt, other
    description TEXT,
    file_url TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (queue_id) REFERENCES p2p_queue(id)
);

-- 4. tl_files 테이블에 마켓플레이스 관련 컬럼 추가
ALTER TABLE tl_files ADD COLUMN marketplace_status TEXT DEFAULT 'none'; -- none, music_market, p2p_queue
ALTER TABLE tl_files ADD COLUMN market_registered_at DATETIME;
ALTER TABLE tl_files ADD COLUMN queue_registered_at DATETIME;
ALTER TABLE tl_files ADD COLUMN uploader_type TEXT DEFAULT 'owner';

-- 5. 인덱스 생성
CREATE INDEX idx_music_market_status ON music_market(status);
CREATE INDEX idx_p2p_queue_status ON p2p_queue(status);
CREATE INDEX idx_p2p_queue_position ON p2p_queue(queue_position);
CREATE INDEX idx_files_marketplace ON tl_files(marketplace_status);

-- 6. 트리거: P2P 대기열에 등록 시 자동으로 순번 부여
CREATE TRIGGER IF NOT EXISTS set_queue_position
AFTER INSERT ON p2p_queue
FOR EACH ROW
WHEN NEW.queue_position IS NULL
BEGIN
    UPDATE p2p_queue 
    SET queue_position = (SELECT COUNT(*) FROM p2p_queue WHERE status = 'pending')
    WHERE id = NEW.id;
END;

-- 7. 뷰: 대기열 현황 확인
CREATE VIEW IF NOT EXISTS v_queue_status AS
SELECT 
    COUNT(*) as total_pending,
    AVG(estimated_wait_days) as avg_wait_days,
    MIN(queue_position) as next_position
FROM p2p_queue 
WHERE status = 'pending';
