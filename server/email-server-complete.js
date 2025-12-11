const express = require('express');
const app = express();

// 미들웨어
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ✅ 1. 루트 페이지
app.get('/', (req, res) => {
  res.json({ 
    message: 'Timelink Email Server - Running!',
    endpoints: [
      'GET  /',
      'POST /api/email/send-verification'
    ]
  });
});

// ✅ 2. 프론트엔드가 호출하는 엔드포인트 (가장 중요!)
app.post('/api/email/send-verification', (req, res) => {
  const { email, code } = req.body;
  
  console.log('\n' + '🎯'.repeat(30));
  console.log('📧 이메일 인증 요청 받음!');
  console.log('👉 이메일:', email);
  console.log('🔑 인증 코드:', code);
  console.log('💡 이 코드를 웹페이지에 입력하세요!');
  console.log('🎯'.repeat(30) + '\n');
  
  res.json({
    success: true,
    message: '개발 모드: 콘솔에서 코드 확인',
    code: code,
    devMode: true
  });
});

// ✅ 3. GET 요청시 안내 메시지
app.get('/api/email/send-verification', (req, res) => {
  res.json({
    error: 'Wrong method',
    message: 'Use POST method instead',
    example: 'curl -X POST http://localhost:3001/api/email/send-verification -H "Content-Type: application/json" -d \'{"email":"test@test.com","code":"123456"}\''
  });
});

// 서버 시작
const PORT = 3001;
app.listen(PORT, () => {
  console.log('\n' + '✅'.repeat(50));
  console.log('🚀 TIMELINK 이메일 서버 시작 완료!');
  console.log(`📍 접속: http://localhost:${PORT}`);
  console.log('📧 엔드포인트: POST /api/email/send-verification');
  console.log('💡 상태: 프론트엔드와 연동 가능');
  console.log('✅'.repeat(50) + '\n');
});
