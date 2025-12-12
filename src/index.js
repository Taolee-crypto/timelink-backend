// src/index.js
export async function fetch(request, env, ctx) {
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

  try {
    if (path === '/api/send-verification' && request.method === 'POST') {
      const data = await request.json().catch(() => null);

      if (!data?.email) {
        return new Response(
          JSON.stringify({ success: false, message: 'Email required' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString();

      if (env.VERIFICATIONS) {
        await env.VERIFICATIONS.put(
          data.email,
          JSON.stringify({ code, expiresAt: Date.now() + 600000 }),
          { expirationTtl: 600 }
        );
      }

      return new Response(
        JSON.stringify({ success: true, code }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    return new Response(
      JSON.stringify({ message: 'Timelink API', endpoints: ['/api/send-verification'] }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
