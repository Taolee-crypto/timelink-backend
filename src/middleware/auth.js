export async function authMiddleware(request, env, ctx) {
  try {
    const authHeader = request.headers.get('Authorization');
    let token;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      const cookies = request.headers.get('Cookie');
      if (cookies) {
        const tokenMatch = cookies.match(/token=([^;]+)/);
        if (tokenMatch) token = tokenMatch[1];
      }
    }
    
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Authentication required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const user = await verifyToken(token, env);
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    request.user = user;
    return;
    
  } catch (error) {
    console.error('Auth middleware error:', error);
    return new Response(
      JSON.stringify({ error: 'Authentication error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function verifyToken(token, env) {
  try {
    const payload = JSON.parse(atob(token));
    
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    const user = await env.DB.prepare(
      'SELECT id, email, username, balance FROM users WHERE id = ?'
    ).bind(payload.userId).first();
    
    return user;
    
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}
