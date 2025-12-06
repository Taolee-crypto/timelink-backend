export default async function logoutHandler(request, env, ctx) {
  try {
    // 토큰 삭제를 위한 응답
    return new Response(
      JSON.stringify({ success: true, message: 'Logged out successfully' }),
      { 
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': 'token=; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
      }
    );
    
  } catch (error) {
    console.error('Logout error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
