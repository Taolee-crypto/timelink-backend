export async function handleAuth(c) {
  const path = c.req.path;
  
  if (path.includes('/signup') && c.req.method === 'POST') {
    return handleSignup(c);
  } else if (path.includes('/login') && c.req.method === 'POST') {
    return handleLogin(c);
  } else if (path.includes('/verify') && c.req.method === 'POST') {
    return handleVerify(c);
  } else if (path.includes('/logout') && c.req.method === 'POST') {
    return handleLogout(c);
  } else if (path.includes('/check') && c.req.method === 'GET') {
    return handleCheckAuth(c);
  }
  
  return c.json({ error: 'Not found' }, 404);
}

async function handleLogin(c) {
  try {
    const { email, password } = await c.req.json();
    
    // 🔥 여기가 핵심! 로그인 성공 시 쿠키 설정
    return c.json({
      success: true,
      message: '로그인 성공',
      user: { 
        email, 
        name: '테스트 사용자',
        wallet: 10000 
      }
    }, 200, {
      'Set-Cookie': 'timelink_auth=logged_in; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict'
    });
    
  } catch (error) {
    return c.json({ success: false, message: '서버 오류' }, 500);
  }
}

async function handleLogout(c) {
  // 🔥 로그아웃 시 쿠키 삭제
  return c.json({
    success: true,
    message: '로그아웃 되었습니다.'
  }, 200, {
    'Set-Cookie': 'timelink_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'
  });
}

async function handleCheckAuth(c) {
  // 쿠키 확인
  const authCookie = c.req.header('Cookie') || '';
  const isLoggedIn = authCookie.includes('timelink_auth=logged_in');
  
  return c.json({
    authenticated: isLoggedIn,
    user: isLoggedIn ? { 
      email: 'user@example.com',
      name: '테스트 사용자',
      wallet: 10000
    } : null
  });
}
