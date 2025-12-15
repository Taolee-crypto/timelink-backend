cat > /c/users/win11/timelink-backend/src/index.js << 'EOF'
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS 헤더 설정 - GitHub Pages 도메인 허용
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://taolee-crypto.github.io',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Allow-Credentials': 'true',
    };

    // OPTIONS 요청 처리 (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        headers: corsHeaders 
      });
    }

    // GitHub Pages 도메인 체크
    const origin = request.headers.get('Origin');
    const allowedOrigins = [
      'https://taolee-crypto.github.io',
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://localhost:3000'
    ];
    
    if (allowedOrigins.includes(origin)) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }

    // 나머지 API 로직은 기존과 동일하게 유지...
    // (이전에 작성한 코드를 여기에 붙여넣기)
    
    // API 기본 정보
    if (path === '/api' || path === '/api/') {
      return Response.json({
        name: 'TimeLink API',
        version: '1.0.0',
        status: 'online',
        timestamp: new Date().toISOString(),
        endpoints: {
          auth: {
            login: '/api/auth/login (POST)',
            signup: '/api/auth/signup (POST)',
            verify: '/api/auth/verify (POST)'
          },
          music: {
            list: '/api/music/list (GET)',
            upload: '/api/music/upload (POST)',
            detail: '/api/music/:id (GET)',
            purchase: '/api/music/:id/purchase (POST)'
          },
          marketplace: {
            listings: '/api/marketplace/listings (GET)',
            create: '/api/marketplace/create (POST)',
            buy: '/api/marketplace/:id/buy (POST)'
          },
          dashboard: {
            stats: '/api/dashboard/stats (GET)',
            earnings: '/api/dashboard/earnings (GET)'
          }
        }
      }, {
        headers: corsHeaders
      });
    }

    // ... 나머지 API 엔드포인트들 ...

    // 404 처리
    return Response.json({
      success: false,
      message: '요청하신 API를 찾을 수 없습니다.',
      path: path,
      method: request.method
    }, {
      status: 404,
      headers: corsHeaders
    });
  }
}
EOF
