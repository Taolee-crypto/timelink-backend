import { Router } from 'itty-router';

const router = Router();

// CORS 미들웨어
const corsMiddleware = (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }
  
  return { headers };
};

// 로거 미들웨어
const loggerMiddleware = (request) => {
  const startTime = Date.now();
  const url = new URL(request.url);
  
  console.log(`[${new Date().toISOString()}] ${request.method} ${url.pathname} - 시작`);
  
  return (response) => {
    const endTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${request.method} ${url.pathname} - ${endTime - startTime}ms - ${response.status}`);
    return response;
  };
};

// 미들웨어 적용 헬퍼
const withMiddleware = (handler) => {
  return async (request, env, ctx) => {
    // CORS 처리
    const corsResult = corsMiddleware(request);
    if (corsResult instanceof Response) {
      return corsResult;
    }
    
    // 로거 설정
    const logger = loggerMiddleware(request);
    
    // 핸들러 실행
    let response;
    try {
      response = await handler(request, env, ctx);
    } catch (error) {
      console.error('Handler error:', error);
      response = new Response(
        JSON.stringify({ error: 'Internal Server Error', message: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsResult.headers } }
      );
    }
    
    // CORS 헤더 추가
    const finalResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: { ...response.headers, ...corsResult.headers }
    });
    
    // 로깅
    return logger ? logger(finalResponse) : finalResponse;
  };
};

// 기본 라우트
router.get('/', withMiddleware(() => {
  return new Response(JSON.stringify({
    message: 'TimeLink API Server',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: ['/api/test', '/api/auth/login', '/api/auth/register']
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}));

// 테스트 엔드포인트
router.get('/api/test', withMiddleware(() => {
  return new Response(JSON.stringify({
    success: true,
    message: 'API is working!',
    database: 'Connected to D1',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}));

// 로그인 엔드포인트
router.post('/api/auth/login', withMiddleware(async (request, env) => {
  try {
    const { email, password } = await request.json();
    
    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: 'Email and password required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // 데이터베이스에서 사용자 조회
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (user) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Login successful',
          user: { id: user.id, email: user.email, username: user.username }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } else {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Server error', details: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}));

// 404 처리
router.all('*', withMiddleware(() => {
  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}));

export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  }
};
