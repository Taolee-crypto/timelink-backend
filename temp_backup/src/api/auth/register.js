export default async function registerHandler(request, env, ctx) {
  try {
    const { email, password, username } = await request.json();
    
    if (!email || !password || !username) {
      return new Response(
        JSON.stringify({ error: 'Email, password, and username are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const existingUser = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (existingUser) {
      return new Response(
        JSON.stringify({ error: 'Email already registered' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const result = await env.DB.prepare(
      'INSERT INTO users (email, password, username, created_at) VALUES (?, ?, ?, ?)'
    ).bind(email, password, username, new Date().toISOString()).run();
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Registration successful',
        userId: result.lastRowId 
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('Registration error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
