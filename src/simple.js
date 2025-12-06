export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    console.log(`Request: ${path}`);
    
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    
    // OPTIONS 요청
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }
    
    // 모든 경로에 대한 기본 응답
    if (path === '/' || path === '/health' || path === '/api/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'TL Platform API',
        timestamp: new Date().toISOString(),
        path: path,
        endpoints: ['/health', '/api', '/api/auth/login']
      }), { headers });
    }
    
    if (path === '/api') {
      return new Response(JSON.stringify({
        name: 'TL Platform API',
        version: '1.0.0',
        endpoints: {
          health: 'GET /health',
          auth: 'POST /api/auth/login'
        }
      }), { headers });
    }
    
    if (path === '/api/auth/login' && request.method === 'POST') {
      try {
        const body = await request.json();
        return new Response(JSON.stringify({
          success: true,
          message: '로그인 성공 (테스트)',
          email: body.email
        }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid JSON'
        }), { 
          status: 400,
          headers 
        });
      }
    }
    
    // 404 처리
    return new Response(JSON.stringify({
      error: 'Not Found',
      path: path,
      timestamp: new Date().toISOString()
    }), {
      status: 404,
      headers
    });
  }
}
