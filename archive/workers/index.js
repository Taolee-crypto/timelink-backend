export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 프로덕션 도메인 (GitHub Pages + 로컬 개발)
    const allowedOrigins = [
      'https://timelink.digital',      // 프로덕션 도메인
      'https://www.timelink.digital',  // www 서브도메인
      'https://taolee-crypto.github.io' // GitHub Pages 직접 URL
    ];
    
    // 개발 모드일 경우 로컬 도메인 추가
    const environment = env.ENVIRONMENT || 'production';
    if (environment === 'development') {
      allowedOrigins.push('http://localhost:3000');
      allowedOrigins.push('http://127.0.0.1:3000');
    }
    
    // 요청 도메인 확인
    const origin = request.headers.get('Origin');
    const isAllowedOrigin = allowedOrigins.includes(origin);
    
    // CORS 헤더 설정
    const corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin' // 다른 Origin에 대해 다른 응답을 허용
    };
    
    // Origin 헤더가 있으면 해당 Origin 허용, 없으면 모든 Origin 허용 (*)
    if (origin && isAllowedOrigin) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    } else if (!origin) {
      // Origin 헤더가 없는 요청 (서버-to-서버, curl 등)
      corsHeaders['Access-Control-Allow-Origin'] = '*';
    } else {
      // 허용되지 않은 Origin
      corsHeaders['Access-Control-Allow-Origin'] = allowedOrigins[0];
    }

    // OPTIONS 요청 처리 (Preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204,
        headers: corsHeaders
      });
    }

    // 루트 경로
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        service: 'TimeLink Backend API',
        message: 'Welcome to TimeLink API',
        endpoints: {
          health: '/health',
          test: '/test',
          api: '/api/*',
          auth: '/api/auth/login',
          content: '/api/content/list'
        },
        timestamp: new Date().toISOString(),
        environment: environment,
        cors: {
          allowedOrigins: allowedOrigins,
          requestOrigin: origin,
          allowedOrigin: corsHeaders['Access-Control-Allow-Origin']
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 헬스 체크
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        service: 'TimeLink Backend API',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: environment,
        frontend: 'https://timelink.digital',
        version: '1.0.0',
        cors: {
          allowedOrigin: corsHeaders['Access-Control-Allow-Origin'],
          requestOrigin: origin
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 테스트 엔드포인트
    if (url.pathname === '/test' || url.pathname === '/api/test') {
      return new Response(JSON.stringify({
        success: true,
        message: 'Backend is working correctly',
        data: {
          timestamp: new Date().toISOString(),
          method: request.method,
          path: url.pathname,
          origin: origin,
          environment: environment
        },
        cors: corsHeaders['Access-Control-Allow-Origin']
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 인증 테스트
    if (url.pathname === '/api/auth/login') {
      try {
        const data = await request.json();
        return new Response(JSON.stringify({
          success: true,
          message: 'Login successful',
          token: 'jwt-token-' + Date.now() + '-' + Math.random().toString(36).substr(2),
          user: {
            id: 1,
            email: data.email || 'user@timelink.digital',
            name: '테스트 사용자',
            role: 'user'
          },
          cors: corsHeaders['Access-Control-Allow-Origin']
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid request',
          message: 'Send JSON with email and password'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 콘텐츠 API
    if (url.pathname === '/api/content/list') {
      return new Response(JSON.stringify({
        success: true,
        items: [
          { id: 1, title: 'Sample Audio 1', type: 'audio', duration: 120, price: 100 },
          { id: 2, title: 'Sample Video 1', type: 'video', duration: 300, price: 200 },
          { id: 3, title: 'Music Track Demo', type: 'audio', duration: 180, price: 150 }
        ],
        total: 3,
        cors: corsHeaders['Access-Control-Allow-Origin']
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 404
    return new Response(JSON.stringify({
      error: 'Not Found',
      message: 'Endpoint not found: ' + url.pathname,
      available_endpoints: [
        '/', 
        '/health', 
        '/test', 
        '/api/health', 
        '/api/test', 
        '/api/auth/login',
        '/api/content/list'
      ],
      timestamp: new Date().toISOString(),
      cors: corsHeaders['Access-Control-Allow-Origin']
    }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}
