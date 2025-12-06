export default {
  async fetch(request, env, ctx) {
    // Origin 가져오기
    const origin = request.headers.get('Origin') || '*';
    
    // CORS 헤더 설정 - 모든 Origin 허용
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    };

    // OPTIONS 요청 처리 (Preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 응답 생성 함수
    const createResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    };

    // API 엔드포인트
    if (path === '/api/health' || path === '/api/health/') {
      return createResponse({
        status: 'ok',
        service: 'timelink-api-worker',
        timestamp: new Date().toISOString(),
        environment: 'development',
        cors: 'enabled',
        origin: origin
      });
    }

    if (path === '/api/uuid' || path === '/api/uuid/') {
      return createResponse({
        success: true,
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        endpoint: path
      });
    }

    if (path === '/api/message' || path === '/api/message/') {
      return createResponse({
        message: 'Hello from TimeLink API!',
        timestamp: new Date().toISOString()
      });
    }

    // 기본 응답
    return createResponse({
      error: 'Not found',
      path: path,
      available_endpoints: ['/api/health', '/api/uuid', '/api/message'],
      note: 'TimeLink API Worker is running'
    }, 404);
  }
};
