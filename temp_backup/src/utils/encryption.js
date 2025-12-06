// 암호화 유틸리티
// 실제 구현에서는 더 강력한 암호화 방법 사용

export function hashPassword(password) {
  // 임시 구현 - 실제로는 bcrypt 등 사용
  return btoa(password);
}

export function verifyPassword(password, hashed) {
  // 임시 구현
  return btoa(password) === hashed;
}

export function generateToken(payload, secret) {
  // JWT 토큰 생성 (간단한 구현)
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header));
  const encodedPayload = btoa(JSON.stringify(payload));
  const signature = btoa(encodedHeader + '.' + encodedPayload + secret);
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = btoa(encodedHeader + '.' + encodedPayload + secret);
    
    if (signature !== expectedSignature) return null;
    
    const payload = JSON.parse(atob(encodedPayload));
    
    // 만료 시간 확인
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return payload;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}
