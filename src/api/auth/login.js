<<<<<<< HEAD
export default async function loginHandler(request, env, ctx) {
  try {
    const { email, password } = await request.json();
    
    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: 'Email and password are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Invalid credentials' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    if (password !== user.password) {
      return new Response(
        JSON.stringify({ error: 'Invalid credentials' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const token = await generateJWT(user, env);
    
    return new Response(
      JSON.stringify({
        success: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          balance: user.balance || 0
        }
      }),
      { 
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': `token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`
        }
      }
    );
    
  } catch (error) {
    console.error('Login error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function generateJWT(user, env) {
  const payload = {
    userId: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24)
  };
  
  return btoa(JSON.stringify(payload));
=======
export async function login(request, env) {
  try {
    const { email, password } = await request.json();
    
    // D1 데이터베이스에서 사용자 조회
    const { results } = await env.DB.prepare(
      `SELECT * FROM users WHERE email = ?`
    ).bind(email).all();
    
    if (results.length === 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: '사용자를 찾을 수 없습니다' 
      }), { status: 401 });
    }
    
    const user = results[0];
    
    // 비밀번호 확인 (실제로는 bcrypt 사용)
    // 임시: 평문 비교 (운영 환경에서는 절대 사용하지 마세요)
    if (password !== user.password) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: '비밀번호가 틀렸습니다' 
      }), { status: 401 });
    }
    
    // JWT 토큰 생성
    const token = await generateToken(user, env.JWT_SECRET);
    
    return new Response(JSON.stringify({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        balance: user.balance
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: '서버 오류가 발생했습니다' 
    }), { status: 500 });
  }
}

async function generateToken(user, secret) {
  // 간단한 JWT 토큰 생성 (실제로는 jose 라이브러리 사용 권장)
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    userId: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24시간
  }));
  const signature = 'temp_signature'; // 실제로는 HMAC SHA256 사용
  
  return `${header}.${payload}.${signature}`;
>>>>>>> origin/main
}
