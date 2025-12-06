export default async function socialAuthHandler(request, env, ctx) {
  try {
    const { provider, token } = await request.json();
    
    if (!provider || !token) {
      return new Response(
        JSON.stringify({ error: 'Provider and token are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // 여기에 소셜 로그인 검증 로직 구현
    // 임시 구현
    const jwtToken = btoa(JSON.stringify({
      userId: 1,
      email: 'social@example.com',
      provider: provider,
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24)
    }));
    
    return new Response(
      JSON.stringify({
        success: true,
        token: jwtToken,
        user: {
          id: 1,
          email: 'social@example.com',
          username: 'socialuser',
          provider: provider
        }
      }),
      { 
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': `token=${jwtToken}; HttpOnly; Secure; SameSite=Strict; Path=/`
        }
      }
    );
    
  } catch (error) {
    console.error('Social auth error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
