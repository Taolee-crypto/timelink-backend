export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS 설정
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://timelink.kr',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    };
    
    // OPTIONS 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // 헬스 체크
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        service: 'TimeLink Backend',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: 'development'
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    // 기본 인증 테스트
    if (url.pathname === '/api/auth/login') {
      try {
        const data = await request.json();
        return new Response(JSON.stringify({
          success: true,
          token: 'demo-jwt-token-for-development',
          user: {
            id: 1,
            email: data.email || 'test@timelink.kr',
            name: '테스트 사용자'
          }
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid request'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }
    
    // 404
    return new Response(JSON.stringify({
      error: 'Not Found',
      message: 'API endpoint not found'
    }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}
