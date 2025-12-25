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

async function handleSignup(c) {
  try {
    const { email, password, nickname, realName } = await c.req.json();
    
    // 필수 필드 검증
    if (!email || !password || !nickname || !realName) {
      return c.json({
        success: false,
        message: '모든 필드를 입력해주세요.'
      }, 400);
    }
    
    // 비밀번호 길이 검증
    if (password.length < 6) {
      return c.json({
        success: false,
        message: '비밀번호는 6자 이상이어야 합니다.'
      }, 400);
    }
    
    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json({
        success: false,
        message: '올바른 이메일 형식을 입력해주세요.'
      }, 400);
    }
    
    // 닉네임 길이 검증
    if (nickname.length < 2 || nickname.length > 20) {
      return c.json({
        success: false,
        message: '닉네임은 2자 이상 20자 이하로 입력해주세요.'
      }, 400);
    }
    
    // 실명 길이 검증
    if (realName.length < 2 || realName.length > 50) {
      return c.json({
        success: false,
        message: '실명은 2자 이상 50자 이하로 입력해주세요.'
      }, 400);
    }
    
    // TODO: 실제 데이터베이스에 사용자 저장하는 코드 추가
    // 임시로 성공 처리
    return c.json({
      success: true,
      message: '회원가입이 완료되었습니다! 10,000 TL이 지급되었습니다.',
      user: {
        email: email,
        name: realName,
        nickname: nickname,
        wallet: 10000,
        verified: false
      }
    }, 201, {
      'Set-Cookie': 'timelink_auth=logged_in; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict'
    });
    
  } catch (error) {
    console.error('회원가입 오류:', error);
    return c.json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.',
      error: process.env.ENVIRONMENT === 'development' ? error.message : undefined
    }, 500);
  }
}

async function handleLogin(c) {
  try {
    const { email, password } = await c.req.json();
    
    // 필수 필드 검증
    if (!email || !password) {
      return c.json({
        success: false,
        message: '이메일과 비밀번호를 입력해주세요.'
      }, 400);
    }
    
    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json({
        success: false,
        message: '올바른 이메일 형식을 입력해주세요.'
      }, 400);
    }
    
    // TODO: 실제 데이터베이스에서 사용자 확인 및 비밀번호 검증
    // 임시 로그인 성공 처리
    
    return c.json({
      success: true,
      message: '로그인 성공',
      user: { 
        email: email,
        name: email.split('@')[0], // 임시 이름
        nickname: email.split('@')[0], // 임시 닉네임
        wallet: 10000,
        verified: true
      }
    }, 200, {
      'Set-Cookie': 'timelink_auth=logged_in; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict'
    });
    
  } catch (error) {
    console.error('로그인 오류:', error);
    return c.json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.',
      error: process.env.ENVIRONMENT === 'development' ? error.message : undefined
    }, 500);
  }
}

async function handleVerify(c) {
  try {
    const { email, verificationCode } = await c.req.json();
    
    if (!email || !verificationCode) {
      return c.json({
        success: false,
        message: '이메일과 인증코드를 입력해주세요.'
      }, 400);
    }
    
    // TODO: 실제 인증 코드 검증 로직
    // 임시 인증 성공 처리
    
    return c.json({
      success: true,
      message: '이메일 인증이 완료되었습니다.'
    });
    
  } catch (error) {
    console.error('인증 오류:', error);
    return c.json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.',
      error: process.env.ENVIRONMENT === 'development' ? error.message : undefined
    }, 500);
  }
}

async function handleLogout(c) {
  // 로그아웃 시 쿠키 삭제
  return c.json({
    success: true,
    message: '로그아웃 되었습니다.'
  }, 200, {
    'Set-Cookie': 'timelink_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'
  });
}

async function handleCheckAuth(c) {
  try {
    // 쿠키 확인
    const authCookie = c.req.header('Cookie') || '';
    const isLoggedIn = authCookie.includes('timelink_auth=logged_in');
    
    if (isLoggedIn) {
      // TODO: 실제 데이터베이스에서 사용자 정보 조회
      // 임시 사용자 정보 반환
      return c.json({
        authenticated: true,
        user: { 
          email: 'user@example.com',
          name: '테스트 사용자',
          nickname: '테스트',
          wallet: 10000,
          verified: true
        }
      });
    } else {
      return c.json({
        authenticated: false,
        user: null
      });
    }
    
  } catch (error) {
    console.error('인증 확인 오류:', error);
    return c.json({
      authenticated: false,
      user: null,
      error: '인증 확인 중 오류가 발생했습니다.'
    }, 500);
  }
}

// 유틸리티 함수들
async function hashPassword(password) {
  // 실제 구현: bcrypt 또는 Web Crypto API 사용
  const encoder = new TextEncoder();
  const data = encoder.encode(password + (process.env.JWT_SECRET || 'timelink_secret'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
  const hashedInput = await hashPassword(password);
  return hashedInput === hash;
}
