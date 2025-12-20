// 사용자 테이블 확인 쿼리
export default {
  async fetch(request, env) {
    try {
      // 사용자 테이블 생성 (없을 경우)
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          nickname TEXT NOT NULL,
          real_name TEXT NOT NULL,
          phone TEXT,
          email_verified BOOLEAN DEFAULT FALSE,
          verification_token TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // 현재 저장된 사용자 수 확인
      const users = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
      
      return new Response(JSON.stringify({
        success: true,
        users_count: users.count,
        message: "데이터베이스 확인 완료"
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      return new Response(JSON.stringify({
        error: "데이터베이스 오류",
        details: error.message
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
