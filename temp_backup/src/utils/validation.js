// 입력 검증 유틸리티

export function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validatePassword(password) {
  // 최소 8자, 영문+숫자+특수문자
  const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/;
  return passwordRegex.test(password);
}

export function validateUsername(username) {
  // 3-20자, 영문+숫자+언더스코어
  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  return usernameRegex.test(username);
}

export function validateContentTitle(title) {
  return title && title.length >= 3 && title.length <= 200;
}

export function validatePrice(price) {
  return !isNaN(price) && price >= 0;
}

export function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  
  // 기본 XSS 방지
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}
