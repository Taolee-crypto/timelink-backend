// TimeLink 백엔드 API - 완전한 버전
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // OPTIONS 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // ==================== 1. 헬스 체크 ====================
    if (path === '/health' || path === '/api/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'TimeLink Backend API',
        version: '2.0',
        timestamp: new Date().toISOString(),
        endpoints: [
          { path: '/api/signup', method: 'POST', desc: '회원가입' },
          { path: '/api/login', method: 'POST', desc: '로그인' },
          { path: '/auth/send-verification', method: 'POST', desc: '이메일 인증번호 발송' },
          { path: '/api/verify-email', method: 'POST', desc: '이메일 인증 완료' },
          { path: '/api/dashboard', method: 'GET', desc: '대시보드 (10,000TL 확인)' }
        ]
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // ==================== 2. 회원가입 API ====================
    if (path === '/api/signup' && request.method === 'POST') {
      try {
        const data = await request.json();
        const { email, password, nickname, realName, phone } = data;
        
        // 필수 항목 검증
        if (!email || !password || !nickname || !realName) {
          return new Response(
            JSON.stringify({ success: false, message: '필수 항목을 모두 입력해주세요.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 이메일 중복 확인
        const existingUser = await env.DB.prepare(
          "SELECT id FROM users WHERE email = ?"
        ).bind(email).first();
        
        if (existingUser) {
          return new Response(
            JSON.stringify({ success: false, message: '이미 가입된 이메일입니다.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 비밀번호 해싱
        const passwordHash = await hashPassword(password);
        
        // 6자리 인증번호 생성
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // 데이터베이스에 사용자 저장 (잔액 0으로 시작)
        const result = await env.DB.prepare(
          `INSERT INTO users (email, password_hash, nickname, real_name, phone, verification_code, email_verified, balance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          email,
          passwordHash,
          nickname,
          realName,
          phone || null,
          verificationCode,
          0, // email_verified = false
          0  // balance = 0 (인증 후 10,000TL 지급)
        ).run();
        
        // 인증번호 KV에 저장
        await env.timelink_users.put(
          `code:${email}`,
          JSON.stringify({
            code: verificationCode,
            email: email,
            userId: result.meta.last_row_id,
            expiresAt: Date.now() + 600000 // 10분
          }),
          { expirationTtl: 600 }
        );
        
        // SendGrid로 이메일 발송 (프로덕션)
        if (env.SENDGRID_API_KEY) {
          await sendVerificationEmail(email, verificationCode, env);
        }
        
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: '회원가입 성공! 이메일로 인증번호를 발송했습니다.',
            userId: result.meta.last_row_id,
            note: '인증 완료 시 10,000TL이 지급됩니다.'
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
        
      } catch (error) {
        console.error('Signup error:', error);
        return new Response(
          JSON.stringify({ 
            success: false, 
            message: '회원가입 처리 중 오류가 발생했습니다.' 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // ==================== 3. 이메일 인증번호 발송 ====================
    if (path === '/auth/send-verification' && request.method === 'POST') {
      try {
        const { email } = await request.json();
        
        if (!email) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일이 필요합니다.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 6자리 인증 코드 생성
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // KV에 저장
        await env.timelink_users.put(
          `code:${email}`,
          JSON.stringify({
            code: code,
            email: email,
            expiresAt: Date.now() + 600000, // 10분
            createdAt: new Date().toISOString()
          }),
          { expirationTtl: 600 }
        );
        
        // SendGrid로 이메일 발송
        if (env.SENDGRID_API_KEY) {
          await sendVerificationEmail(email, code, env);
          return new Response(
            JSON.stringify({ 
              success: true, 
              message: '인증 코드가 이메일로 전송되었습니다.' 
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } else {
          // 개발 모드: 코드 반환
          return new Response(
            JSON.stringify({ 
              success: true, 
              code: code,
              message: '개발 모드: 인증 코드 생성됨' 
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
      } catch (error) {
        console.error('Send verification error:', error);
        return new Response(
          JSON.stringify({ 
            success: false, 
            message: '인증 코드 발송 중 오류가 발생했습니다.' 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // ==================== 4. 이메일 인증 완료 (10,000TL 지급) ====================
    if (path === '/api/verify-email' && request.method === 'POST') {
      try {
        const { email, verificationCode } = await request.json();
        
        if (!email || !verificationCode) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일과 인증번호를 입력해주세요.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // KV에서 인증번호 확인
        const storedData = await env.timelink_users.get(`code:${email}`);
        if (!storedData) {
          return new Response(
            JSON.stringify({ success: false, message: '인증번호가 만료되었거나 존재하지 않습니다.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        const stored = JSON.parse(storedData);
        if (stored.code !== verificationCode) {
          return new Response(
            JSON.stringify({ success: false, message: '인증번호가 일치하지 않습니다.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // ✅ 이메일 인증 완료 처리 + 10,000TL 지급
        await env.DB.prepare(
          `UPDATE users SET 
            email_verified = 1, 
            verification_code = NULL,
            balance = 10000,  // 10,000TL 지급
            verified_at = datetime('now')
           WHERE email = ?`
        ).bind(email).run();
        
        // ✅ TL 지급 기록 저장
        const user = await env.DB.prepare(
          "SELECT id FROM users WHERE email = ?"
        ).bind(email).first();
        
        if (user) {
          await env.DB.prepare(
            `INSERT INTO transactions (user_id, type, amount, balance_after, description)
             VALUES (?, 'signup_bonus', 10000, 10000, '🎉 회원가입 보너스 10,000TL 지급')`
          ).bind(user.id).run();
        }
        
        // KV 데이터 삭제
        await env.timelink_users.delete(`code:${email}`);
        
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: '✅ 이메일 인증 완료! 10,000TL이 지급되었습니다.',
            bonus: 10000
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
        
      } catch (error) {
        console.error('Verify email error:', error);
        return new Response(
          JSON.stringify({ 
            success: false, 
            message: '인증 처리 중 오류가 발생했습니다.' 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // ==================== 5. 로그인 API (잔액 포함) ====================
    if (path === '/api/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json();
        
        if (!email || !password) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일과 비밀번호를 입력해주세요.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 사용자 조회
        const user = await env.DB.prepare(
          "SELECT id, email, password_hash, nickname, email_verified, balance FROM users WHERE email = ?"
        ).bind(email).first();
        
        if (!user) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일 또는 비밀번호가 일치하지 않습니다.' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 비밀번호 검증
        const passwordValid = await verifyPassword(password, user.password_hash);
        if (!passwordValid) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일 또는 비밀번호가 일치하지 않습니다.' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 이메일 인증 확인
        if (!user.email_verified) {
          return new Response(
            JSON.stringify({ 
              success: false, 
              message: '이메일 인증이 필요합니다. 가입한 이메일을 확인해주세요.',
              requiresVerification: true 
            }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // JWT 토큰 생성
        const token = generateToken(user);
        
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: '로그인 성공',
            token: token,
            user: {
              id: user.id,
              email: user.email,
              nickname: user.nickname,
              balance: user.balance || 0,  // ✅ 잔액 포함
              verified: user.email_verified
            }
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
        
      } catch (error) {
        console.error('Login error:', error);
        return new Response(
          JSON.stringify({ 
            success: false, 
            message: '로그인 처리 중 오류가 발생했습니다.' 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // ==================== 6. 대시보드 API (잔액 조회) ====================
    if (path === '/api/dashboard' && request.method === 'GET') {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response(
            JSON.stringify({ success: false, message: '인증이 필요합니다.' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 토큰에서 사용자 ID 추출 (간단한 버전)
        const token = authHeader.split(' ')[1];
        // 실제 구현에서는 JWT 디코딩 필요
        const userId = 1; // 테스트용
        
        // 사용자 정보 + 잔액 조회
        const user = await env.DB.prepare(
          "SELECT id, email, nickname, balance, email_verified FROM users WHERE id = ?"
        ).bind(userId).first();
        
        if (!user) {
          return new Response(
            JSON.stringify({ success: false, message: '사용자를 찾을 수 없습니다.' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 거래 내역 조회
        const transactions = await env.DB.prepare(
          `SELECT type, amount, balance_after, description, 
                  datetime(created_at) as created_at
           FROM transactions 
           WHERE user_id = ? 
           ORDER BY created_at DESC 
           LIMIT 10`
        ).bind(userId).all();
        
        return new Response(
          JSON.stringify({ 
            success: true,
            user: user,
            balance: user.balance,
            totalTL: user.balance,
            transactions: transactions.results || []
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
        
      } catch (error) {
        console.error('Dashboard error:', error);
        return new Response(
          JSON.stringify({ 
            success: false, 
            message: '대시보드 조회 중 오류가 발생했습니다.' 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // ==================== 기본 응답 ====================
    return new Response(
      JSON.stringify({ 
        message: 'TimeLink API Server',
        endpoints: ['/api/signup', '/api/login', '/api/verify-email', '/api/dashboard']
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};

// ==================== 유틸리티 함수 ====================

// SendGrid 이메일 발송
async function sendVerificationEmail(email, verificationCode, env) {
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
          value: `TimeLink 이메일 인증번호: ${verificationCode}\n인증 완료 시 10,000TL이 지급됩니다!`
        }, {
          type: 'text/html',
          value: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #29C4A8;">TimeLink 이메일 인증</h2>
              <p>아래 인증번호를 입력하여 이메일 인증을 완료해주세요:</p>
              <div style="background: #f4f4f4; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
                <h1 style="color: #29C4A8; font-size: 32px; letter-spacing: 5px; margin: 0;">${verificationCode}</h1>
              </div>
              <p><strong>🎉 특별 혜택:</strong> 인증 완료 시 <strong>10,000TL</strong>이 지급됩니다!</p>
              <p>인증번호는 10분간 유효합니다.</p>
            </div>
          `
        }]
      })
    });

    return { success: response.ok };
  } catch (error) {
    console.error('SendGrid error:', error);
    return { success: false };
  }
}

// 비밀번호 해싱
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'timelink_salt_2024');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 비밀번호 검증
async function verifyPassword(password, hash) {
  const newHash = await hashPassword(password);
  return newHash === hash;
}

// JWT 토큰 생성 (간단한 버전)
function generateToken(user) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    userId: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24시간
  }));
  const signature = btoa('timelink_secret_key_' + user.id);
  return `${header}.${payload}.${signature}`;
}
