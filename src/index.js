export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    // OPTIONS 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // 헬스 체크
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'TimeLink Backend API',
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // 이메일 인증 API
    if (path === '/auth/send-verification' && request.method === 'POST') {
      try {
        const { email } = await request.json();
        
        if (!email) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일이 필요합니다.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // 6자리 인증 코드 생성
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // KV에 저장
        await env.timelink_users.put(
          `code:${email}`,
          JSON.stringify({
            code: code,
            email: email,
            expiresAt: Date.now() + 600000, // 10분
            createdAt: new Date().toISOString()
          }),
          { expirationTtl: 600 }
        );
        
        // 개발/프로덕션 모드 구분
        if (env.ENVIRONMENT === 'production' && env.SENDGRID_API_KEY) {
          // 프로덕션: 실제 SendGrid 호출
          return new Response(
            JSON.stringify({ 
              success: true, 
              message: '인증 코드가 이메일로 전송되었습니다.' 
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } else {
          // 개발 모드: 코드 반환
          return new Response(
            JSON.stringify({ 
              success: true, 
              code: code,
              message: '개발 모드: 인증 코드 생성됨' 
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            message: '서버 오류가 발생했습니다.' 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // 기본 응답
    return new Response('TimeLink 백엔드 작동중!', {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
    });
  }
};
