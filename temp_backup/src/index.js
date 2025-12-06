import { Router } from 'itty-router';

const router = Router();

// CORS 헤더
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

router.all('*', (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }
});

// 기본 라우트
router.get('/', () => {
  return new Response(
    JSON.stringify({
      message: 'TimeLink API Server v2',
      status: 'running',
      version: '2.0',
      timestamp: new Date().toISOString(),
      endpoints: ['/api/test', '/api/auth/login', '/api/auth/register']
    }),
    { 
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  );
});

// 테스트 엔드포인트
router.get('/api/test', async (request, env) => {
  try {
    // 데이터베이스 연결 테스트
    const result = await env.DB.prepare('SELECT 1 as test').first();
    return new Response(
      JSON.stringify({
        success: true,
        message: 'API and Database are working!',
        database: result ? 'Connected' : 'Error',
        timestamp: new Date().toISOString()
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Database error',
        error: error.message
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

// 로그인 엔드포인트
router.post('/api/auth/login', async (request, env) => {
  try {
    const body = await request.json();
    const { email, password } = body;
    
    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: 'Email and password required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // 데이터베이스에서 사용자 확인
    const user = await env.DB.prepare(
      'SELECT id, email, username, balance FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (user) {
      // 임시 토큰 생성 (실제로는 JWT 사용)
      const token = btoa(JSON.stringify({
        userId: user.id,
        email: user.email,
        exp: Math.floor(Date.now() / 1000) + 86400 // 24시간
      }));
      
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Login successful',
          token: token,
          user: user
        }),
        { 
          status: 200, 
          headers: { 
            ...corsHeaders, 
            'Content-Type': 'application/json',
            'Set-Cookie': `token=${token}; HttpOnly; Secure; SameSite=Strict`
          }
        }
      );
    } else {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Server error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// 회원가입 엔드포인트
router.post('/api/auth/register', async (request, env) => {
  try {
    const body = await request.json();
    const { email, password, username } = body;
    
    if (!email || !password || !username) {
      return new Response(
        JSON.stringify({ error: 'Email, password, and username are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // 이메일 중복 확인
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (existing) {
      return new Response(
        JSON.stringify({ error: 'Email already registered' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // 사용자 생성
    const result = await env.DB.prepare(
      'INSERT INTO users (email, password, username, created_at) VALUES (?, ?, ?, ?)'
    ).bind(email, password, username, new Date().toISOString()).run();
    
    return new Response(
      JSON.stringify({
        success: true,
        message: 'User registered successfully',
        userId: result.lastRowId
      }),
      { 
        status: 201, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Registration failed', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// 사용자 프로필
router.get('/api/user/profile', async (request, env) => {
  try {
    const users = await env.DB.prepare(
      'SELECT id, email, username, balance, created_at FROM users LIMIT 10'
    ).all();
    
    return new Response(
      JSON.stringify({
        success: true,
        users: users.results,
        count: users.results.length
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Database error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// 콘텐츠 목록
router.get('/api/content/list', async (request, env) => {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit')) || 10;
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    
    const contents = await env.DB.prepare(
      `SELECT c.*, u.username as creator_name 
       FROM content c 
       JOIN users u ON c.user_id = u.id 
       WHERE c.status = 'active' 
       ORDER BY c.created_at DESC 
       LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    
    return new Response(
      JSON.stringify({
        success: true,
        contents: contents.results,
        pagination: { limit, offset, total: contents.results.length }
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Database error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// 마켓 목록
router.get('/api/market/list', async (request, env) => {
  try {
    const items = await env.DB.prepare(
      `SELECT m.*, c.title, c.description, u.username as seller_name
       FROM market_items m
       JOIN content c ON m.content_id = c.id
       JOIN users u ON m.seller_id = u.id
       WHERE m.status = 'active'
       ORDER BY m.created_at DESC
       LIMIT 20`
    ).all();
    
    return new Response(
      JSON.stringify({
        success: true,
        items: items.results,
        count: items.results.length
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Database error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// 404 처리
router.all('*', () => {
  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { 
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  );
});

export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  }
};
