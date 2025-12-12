// CORS 설정 포함한 Timelink API Worker
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 예시 API
    if (path === '/api/send-verification' && request.method === 'POST') {
      let data;
      try { data = await request.json(); } 
      catch { return new Response(JSON.stringify({ success: false, message: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }); }

      const { email } = data;
      if (!email) return new Response(JSON.stringify({ success: false, message: 'Email required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      if (env.VERIFICATIONS) await env.VERIFICATIONS.put(email, JSON.stringify({ code, expiresAt: Date.now() + 600000 }), { expirationTtl: 600 });

      return new Response(JSON.stringify({ success: true, message: 'Verification code sent', code }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response(JSON.stringify({ message: 'Timelink API', endpoints: ['/api/send-verification'] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
};
