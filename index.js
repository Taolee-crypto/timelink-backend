export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 1. 헬스 체크
    if (path === '/api/health') {
      return Response.json({
        status: 'ok',
        service: 'TimeLink Backend',
        timestamp: new Date().toISOString(),
        version: '2.0',
        message: '모든 기능 작동 중'
      }, { headers: corsHeaders });
    }
    
    // 2. 실제 회원가입
    if (path === '/api/signup' && request.method === 'POST') {
      try {
        const data = await request.json();
        const { email, password, nickname, realName } = data;
        
        // 검증
        if (!email || !password || !nickname || !realName) {
          return Response.json(
            { success: false, error: '필수 항목 누락' },
            { status: 400, headers: corsHeaders }
          );
        }
        
        // 중복 확인
        const existing = await env.DB.prepare(
          "SELECT id FROM users WHERE email = ?"
        ).bind(email).first();
        
        if (existing) {
          return Response.json(
            { success: false, error: '이미 가입된 이메일' },
            { status: 400, headers: corsHeaders }
          );
        }
        
        // 비밀번호 해싱
        const passwordHash = await simpleHash(password);
        
        // 6자리 인증번호 생성
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // D1 데이터베이스에 저장
        const result = await env.DB.prepare(
          `INSERT INTO users (email, password_hash, nickname, real_name, verification_code, balance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(email, passwordHash, nickname, realName, verificationCode, 0).run();
        
        // SendGrid로 실제 이메일 발송
        const emailSent = await sendVerificationEmail(email, verificationCode, env);
        
        return Response.json({
          success: true,
          message: '회원가입 성공! 이메일로 인증번호를 발송했습니다.',
          userId: result.meta.last_row_id,
          note: '인증 완료 시 10,000TL 지급'
        }, { headers: corsHeaders });
        
      } catch (error) {
        return Response.json(
          { success: false, error: '서버 오류: ' + error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 3. 이메일 인증 완료 (10,000TL 지급)
    if (path === '/api/verify-email' && request.method === 'POST') {
      try {
        const { email, verificationCode } = await request.json();
        
        // 사용자 조회
        const user = await env.DB.prepare(
          "SELECT id, verification_code FROM users WHERE email = ? AND email_verified = 0"
        ).bind(email).first();
        
        if (!user) {
          return Response.json(
            { success: false, error: '사용자를 찾을 수 없음' },
            { status: 400, headers: corsHeaders }
          );
        }
        
        // 인증번호 확인
        if (user.verification_code !== verificationCode) {
          return Response.json(
            { success: false, error: '인증번호 불일치' },
            { status: 400, headers: corsHeaders }
          );
        }
        
        // ✅ 이메일 인증 완료 + 10,000TL 지급
        await env.DB.prepare(
          "UPDATE users SET email_verified = 1, verification_code = NULL, balance = 10000 WHERE id = ?"
        ).bind(user.id).run();
        
        // 거래 기록 저장
        await env.DB.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description)
           VALUES (?, 'signup_bonus', 10000, 10000, '회원가입 보너스 10,000TL')`
        ).bind(user.id).run();
        
        return Response.json({
          success: true,
          message: '이메일 인증 완료! 10,000TL이 지급되었습니다.',
          bonus: 10000
        }, { headers: corsHeaders });
        
      } catch (error) {
        return Response.json(
          { success: false, error: '인증 오류: ' + error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 4. 실제 로그인 (잔액 포함)
    if (path === '/api/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json();
        
        const user = await env.DB.prepare(
          "SELECT id, email, password_hash, nickname, email_verified, balance FROM users WHERE email = ?"
        ).bind(email).first();
        
        if (!user) {
          return Response.json(
            { success: false, error: '이메일 또는 비밀번호 불일치' },
            { status: 401, headers: corsHeaders }
          );
        }
        
        // 비밀번호 검증
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
          return Response.json(
            { success: false, error: '이메일 또는 비밀번호 불일치' },
            { status: 401, headers: corsHeaders }
          );
        }
        
        // 이메일 인증 확인
        if (!user.email_verified) {
          return Response.json(
            { success: false, error: '이메일 인증 필요', requiresVerification: true },
            { status: 401, headers: corsHeaders }
          );
        }
        
        // JWT 토큰 생성
        const token = `tl_${user.id}_${Date.now()}`;
        
        return Response.json({
          success: true,
          token: token,
          user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            balance: user.balance, // ✅ 잔액 포함
            verified: user.email_verified
          },
          message: '로그인 성공'
        }, { headers: corsHeaders });
        
      } catch (error) {
        return Response.json(
          { success: false, error: '로그인 오류: ' + error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 5. 대시보드 (잔액 확인)
    if (path === '/api/dashboard' && request.method === 'GET') {
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return Response.json(
          { success: false, error: '인증 필요' },
          { status: 401, headers: corsHeaders }
        );
      }
      
      // 간단한 토큰 파싱 (user ID 추출)
      const token = auth.replace('Bearer ', '');
      const userId = token.split('_')[1] || 1;
      
      const user = await env.DB.prepare(
        "SELECT id, email, nickname, balance FROM users WHERE id = ?"
      ).bind(userId).first();
      
      if (!user) {
        return Response.json(
          { success: false, error: '사용자 없음' },
          { status: 404, headers: corsHeaders }
        );
      }
      
      return Response.json({
        success: true,
        user: user,
        balance: user.balance,
        message: `현재 잔액: ${user.balance}TL`
      }, { headers: corsHeaders });
    }
    
    // 기본 응답
    return Response.json(
      { error: 'Not Found', path: path },
      { status: 404, headers: corsHeaders }
    );
  }
};

// 유틸리티 함수들
async function simpleHash(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'timelink_salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
  const newHash = await simpleHash(password);
  return newHash === hash;
}

async function sendVerificationEmail(email, code, env) {
  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: email }] }],
        from: { email: env.EMAIL_FROM || 'noreply@timelink.digital' },
        subject: 'TimeLink 이메일 인증번호',
        content: [{
          type: 'text/plain',
          value: `TimeLink 인증번호: ${code}\n인증 완료 시 10,000TL 지급!`
        }]
      })
    });
    return response.ok;
  } catch {
    return false;
  }
}
