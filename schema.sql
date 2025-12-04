-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  tl_balance INTEGER DEFAULT 10000,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 파일 테이블
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'tl3', 'tl4'
  price_per_second DECIMAL(10,2) NOT NULL,
  total_seconds INTEGER NOT NULL,
  used_seconds INTEGER DEFAULT 0,
  earnings DECIMAL(10,2) DEFAULT 0,
  r2_key TEXT NOT NULL, -- R2에 저장된 파일 키
  is_certified BOOLEAN DEFAULT 0,
  is_studio BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 마켓 아이템 테이블
CREATE TABLE IF NOT EXISTS market_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  status TEXT DEFAULT 'active', -- 'active', 'sold', 'canceled'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (seller_id) REFERENCES users(id)
);

-- 거래 내역 테이블
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- 'charge', 'purchase', 'sale', 'conversion'
  amount DECIMAL(10,2) NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
