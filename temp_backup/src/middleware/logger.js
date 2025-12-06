export function loggerMiddleware(request) {
  const startTime = Date.now();
  const url = new URL(request.url);
  
  // 요청 정보 로깅
  console.log(`[${new Date().toISOString()}] ${request.method} ${url.pathname} - 시작`);
  
  // 응답이 완료된 후 로깅하기 위한 처리
  return async (response) => {
    const endTime = Date.now();
    const duration = endTime - startTime;
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    
    console.log(`[${new Date().toISOString()}] ${request.method} ${url.pathname} - ${ip} - ${duration}ms - ${response.status}`);
    return response;
  };
}
