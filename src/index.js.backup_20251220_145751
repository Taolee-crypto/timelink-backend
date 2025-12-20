// TimeLink 백엔드 API 서버 - 수정된 버전
import { hash, verify } from '@node-rs/bcrypt';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // API 라우팅
    if (path.startsWith('/api')) {
      return handleAPI(request, env, path, corsHeaders);
    }
    
    return new Response('TimeLink API Server v2', { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};

async function handleAPI(request, env, path, corsHeaders) {
  try {
    if (path === '/api/signup' && request.method === 'POST') {
      return await handleSignup(request, env, corsHeaders);
    }
    
    if (path === '/api/login' && request.method === 'POST') {
      return await handleLogin(request, env, corsHeaders);
    }
    
    if (path === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        environment: env.ENVIRONMENT,
        version: '2.0'
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    if (path === '/api/debug/users') {
      return await debugUsers(env, corsHeaders);
    }
    
    return new Response(JSON.stringify({ 
      error: 'API endpoint not found',
      path: path 
    }), { 
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
    
  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 📝 회원가입 처리 (실제 데이터베이스 저장)
async function handleSignup(request, env, corsHeaders) {
  try {
    const data = await request.json();
    
    // 필수 필드 검증
    if (!data.email || !data.password || !data.nickname || !data.realName) {
      return new Response(JSON.stringify({ 
        error: '필수 항목이 누락되었습니다' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // 이메일 중복 확인
    const existingUser = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ?"
    ).bind(data.email).first();
    
    if (existingUser) {
      return new Response(JSON.stringify({ 
        error: '이미 가입된 이메일입니다' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // 비밀번호 해싱 (bcrypt)
    const passwordHash = await hash(data.password, 10);
    
    // 인증 토큰 생성
    const verificationToken = crypto.randomUUID();
    
    // 데이터베이스에 사용자 저장
    const result = await env.DB.prepare(
      `INSERT INTO users (email, password_hash, nickname, real_name, phone, verification_token, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      data.email,
      passwordHash,
      data.nickname,
      data.realName,
      data.phone || null,
      verificationToken,
      false
    ).run();
    
    if (!result.success) {
      throw new Error('데이터베이스 저장 실패');
    }
    
    // 이메일 인증 메일 발송 (SendGrid)
    // TODO: SendGrid 연동 구현
    
    return new Response(JSON.stringify({ 
      success: true,
      message: '회원가입이 완료되었습니다. 이메일 인증이 필요합니다.',
      userId: result.meta.last_row_id,
      requiresVerification: true
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
    
  } catch (error) {
    console.error('Signup error:', error);
    return new Response(JSON.stringify({ 
      error: '회원가입 처리 중 오류 발생',
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 🔐 로그인 처리 (실제 비밀번호 검증)
async function handleLogin(request, env, corsHeaders) {
  try {
    const data = await request.json();
    
    if (!data.email || !data.password) {
      return new Response(JSON.stringify({ 
        error: '이메일과 비밀번호를 입력해주세요' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // 데이터베이스에서 사용자 조회
    const user = await env.DB.prepare(
      "SELECT id, email, password_hash, nickname, email_verified FROM users WHERE email = ?"
    ).bind(data.email).first();
    
    if (!user) {
      return new Response(JSON.stringify({ 
        success: false,
        error: '이메일 또는 비밀번호가 일치하지 않습니다'
      }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // 비밀번호 검증
    const passwordValid = await verify(data.password, user.password_hash);
    
    if (!passwordValid) {
      return new Response(JSON.stringify({ 
        success: false,
        error: '이메일 또는 비밀번호가 일치하지 않습니다'
      }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // 이메일 인증 확인
    if (!user.email_verified) {
      return new Response(JSON.stringify({ 
        success: false,
        error: '이메일 인증이 필요합니다. 가입한 이메일을 확인해주세요.',
        requiresVerification: true
      }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // JWT 토큰 생성 (임시)
    const token = `jwt_${user.id}_${Date.now()}`;
    
    return new Response(JSON.stringify({
      success: true,
      message: '로그인 성공',
      token: token,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        verified: user.email_verified
      }
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({
      error: '로그인 처리 중 오류 발생',
      message: error.message
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 🔧 디버그용: 저장된 사용자 확인
async function debugUsers(env, corsHeaders) {
  try {
    const users = await env.DB.prepare("SELECT id, email, nickname, email_verified, created_at FROM users").all();
    
    return new Response(JSON.stringify({
      success: true,
      count: users.results.length,
      users: users.results
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: "사용자 조회 실패",
      details: error.message
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
