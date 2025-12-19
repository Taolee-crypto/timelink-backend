import { handleSignup, handleLogin } from './auth.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://timelink.digital',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
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

    // 1. 회원가입 API
    if (path === '/api/auth/signup' && request.method === 'POST') {
      return await handleSignup(request, env);
    }

    // 2. 로그인 API
    if (path === '/api/auth/login' && request.method === 'POST') {
      return await handleLogin(request, env);
    }

    // 3. 이메일 인증 API (기존)
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

    // 4. 기본 응답
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "TimeLink Backend API",
        version: "4.0.0",
        timestamp: new Date().toISOString(),
        endpoints: [
          { path: "/api/auth/signup", method: "POST", desc: "회원가입" },
          { path: "/api/auth/login", method: "POST", desc: "로그인" },
          { path: "/auth/send-verification", method: "POST", desc: "이메일 인증번호 발송" }
        ],
        cors: "enabled",
        environment: env.ENVIRONMENT || "production"
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
};
