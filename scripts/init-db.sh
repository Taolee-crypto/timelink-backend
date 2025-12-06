#!/bin/bash
# 데이터베이스 초기화 스크립트

echo "TimeLink 데이터베이스 초기화 스크립트"
echo "======================================"

# 환경변수 로드
if [ -f .env ]; then
    source .env
    echo ".env 파일 로드됨"
else
    echo "경고: .env 파일이 없습니다. .env.example을 참조하여 생성해주세요."
fi

# 데이터베이스 파일 확인
DB_FILE="${DATABASE_FILE:-./timelink.db}"

echo ""
echo "1. 기존 데이터베이스 백업..."
if [ -f "$DB_FILE" ]; then
    BACKUP_FILE="${DB_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$DB_FILE" "$BACKUP_FILE"
    echo "  백업 생성: $BACKUP_FILE"
else
    echo "  기존 데이터베이스가 없습니다."
fi

echo ""
echo "2. 새 데이터베이스 생성..."
sqlite3 "$DB_FILE" < schema.sql

if [ $? -eq 0 ]; then
    echo "  ✓ 데이터베이스 생성 완료: $DB_FILE"
    
    # 테스트 데이터 삽입 (옵션)
    if [ "$1" = "--test-data" ]; then
        echo ""
        echo "3. 테스트 데이터 삽입..."
        sqlite3 "$DB_FILE" << 'TEST_DATA'
-- 테스트 사용자 (비밀번호: test123)
INSERT OR IGNORE INTO users (email, password, username, bio, role) VALUES
('user1@example.com', 'test123', 'testuser1', '테스트 사용자 1', 'user'),
('creator1@example.com', 'test123', 'musiccreator', '음악 크리에이터', 'creator'),
('user2@example.com', 'test123', 'audiophile', '오디오 애호가', 'user');

-- 테스트 콘텐츠
INSERT OR IGNORE INTO content (user_id, title, description, file_url, file_type, category, price) VALUES
(2, 'Morning Jazz', '아침을 깨우는 재즈 음악', 'https://example.com/audio1.mp3', 'audio', 'music', 5.99),
(2, 'Electronic Beats', '에너지 넘치는 일렉트로닉 비트', 'https://example.com/audio2.mp3', 'audio', 'music', 7.99),
(1, 'Nature Sounds', '자연의 소리 모음', 'https://example.com/audio3.mp3', 'audio', 'nature', 3.99);

-- 테스트 마켓 아이템
INSERT OR IGNORE INTO market_items (content_id, seller_id, price) VALUES
(1, 2, 5.99),
(2, 2, 7.99),
(3, 1, 3.99);

-- 테스트 트랜잭션
INSERT OR IGNORE INTO transactions (user_id, transaction_type, amount, description) VALUES
(3, 'deposit', 50.00, '초기 입금'),
(3, 'purchase', 5.99, 'Morning Jazz 구매');

-- 테스트 구매 기록
INSERT OR IGNORE INTO purchases (buyer_id, content_id, price) VALUES
(3, 1, 5.99);

echo "  ✓ 테스트 데이터 삽입 완료"
        
        echo ""
        echo "테스트 데이터 확인:"
        echo "사용자:"
        sqlite3 -column -header "$DB_FILE" "SELECT id, email, username, role, balance FROM users;"
        
        echo ""
        echo "콘텐츠:"
        sqlite3 -column -header "$DB_FILE" "SELECT id, title, category, price FROM content;"
    fi
    
else
    echo "  ✗ 데이터베이스 생성 실패"
    exit 1
fi

echo ""
echo "======================================"
echo "데이터베이스 초기화 완료!"
echo "파일 위치: $DB_FILE"
