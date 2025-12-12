// src/index.js

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event))
})

async function handleRequest(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const url = new URL(request.url)
  const path = url.pathname

  try {
    if (path === '/api/send-verification' && request.method === 'POST') {
      let data
      try {
        data = await request.json()
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      const { email } = data
      if (!email) {
        return new Response(JSON.stringify({ success: false, message: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString()

      if (env.VERIFICATIONS) {
        await env.VERIFICATIONS.put(
          email,
          JSON.stringify({ code, expiresAt: Date.now() + 600000, createdAt: Date.now() }),
          { expirationTtl: 600 }
        )
      }

      console.log(`[SEND CODE] ${email} -> ${code}`)

      return new Response(JSON.stringify({ success: true, message: 'Verification code sent', code }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    return new Response(JSON.stringify({ message: 'Timelink API', endpoints: ['/api/send-verification', '/api/verify-code', '/api/signup'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
}
