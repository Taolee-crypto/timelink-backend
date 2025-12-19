export async function handleSignup(request, env) {
  try {
    const { email, password, name } = await request.json();
    
    // 1. 입력 검증
    if (!email || !password || !name) {
      return new Response(
        JSON.stringify({
          success: false,
          message: '이메일, 비밀번호, 이름을 모두 입력해주세요.'
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    // 2. 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: '올바른 이메일 형식이 아닙니다.'
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    // 3. 비밀번호 길이 검증
    if (password.length < 6) {
      return new Response(
        JSON.stringify({
          success: false,
          message: '비밀번호는 최소 6자 이상이어야 합니다.'
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    // 4. 데이터베이스에 사용자 저장 (D1 예시)
    // 주석 해제하고 실제 구현 시 사용
    /*
    const userId = crypto.randomUUID();
    const hashedPassword = await hashPassword(password);
    
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, username, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, email, hashedPassword, name, new Date().toISOString()).run();
    */
    
    // 5. 성공 응답
    return new Response(
      JSON.stringify({
        success: true,
        message: '회원가입이 완료되었습니다. 이메일 인증을 완료해주세요.',
        data: {
          userId: 'temp-id-' + Date.now(), // 임시 ID
          email: email,
          username: name,
          createdAt: new Date().toISOString()
        }
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('회원가입 오류:', error);
    return new Response(
      JSON.stringify({
        success: false,
        message: '서버 오류가 발생했습니다.',
        error: env.ENVIRONMENT === 'development' ? error.message : undefined
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

export async function handleLogin(request, env) {
  try {
    const { email, password } = await request.json();
    
    if (!email || !password) {
      return new Response(
        JSON.stringify({
          success: false,
          message: '이메일과 비밀번호를 입력해주세요.'
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    // TODO: 데이터베이스에서 사용자 조회 및 비밀번호 검증
    /*
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (!user || !await verifyPassword(password, user.password_hash)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: '이메일 또는 비밀번호가 올바르지 않습니다.'
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    */
    
    // 임시 성공 응답
    return new Response(
      JSON.stringify({
        success: true,
        message: '로그인 성공 (개발 모드)',
        data: {
          token: 'dev-jwt-token-' + Date.now(),
          user: {
            email: email,
            username: '개발용 사용자',
            userId: 'dev-user-id'
          }
        }
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('로그인 오류:', error);
    return new Response(
      JSON.stringify({
        success: false,
        message: '로그인 처리 중 오류 발생'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// 유틸리티 함수들
async function hashPassword(password) {
  // 실제 구현: bcrypt 또는 Web Crypto API 사용
  const encoder = new TextEncoder();
  const data = encoder.encode(password + env.JWT_SECRET);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
  const hashedInput = await hashPassword(password);
  return hashedInput === hash;
}
