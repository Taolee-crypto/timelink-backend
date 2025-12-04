export default {
  async login(request, env) {
    const { username, password } = await request.json();
    
    // D1에서 사용자 조회
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).bind(username).first();
    
    if (!user || user.password !== password) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // JWT 토큰 생성
    const token = await createJWT(user, env.JWT_SECRET);
    
    return new Response(JSON.stringify({
      token,
      user: {
        id: user.id,
        username: user.username,
        tl: user.tl_balance
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
