export default async function testHandler(request, env, ctx) {
  return new Response(
    JSON.stringify({
      success: true,
      message: 'TimeLink API is working!',
      timestamp: new Date().toISOString(),
      endpoints: {
        auth: '/api/auth/*',
        user: '/api/user/*',
        content: '/api/content/*',
        studio: '/api/studio/*',
        market: '/api/market/*',
        tube: '/api/tube/*',
        copyright: '/api/copyright/*',
        payment: '/api/payment/*',
        admin: '/api/admin/*'
      }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
