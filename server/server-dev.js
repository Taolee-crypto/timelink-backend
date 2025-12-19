const express = require('express');
const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.post('/api/email/send-verification', (req, res) => {
  const { email, code } = req.body;
  
  console.log('\n✨' + '='.repeat(50) + '✨');
  console.log('🎯 TIMELINK 인증 시스템 (개발 모드)');
  console.log('📧 이메일:', email);
  console.log('🔐 인증 코드:', code);
  console.log('⏰ 시간:', new Date().toLocaleTimeString());
  console.log('💡 이 코드를 회원가입 페이지에 입력하세요!');
  console.log('✨' + '='.repeat(50) + '✨\n');
  
  res.json({
    success: true,
    message: '개발 모드: 콘솔에서 코드 확인',
    code: code,
    devMode: true,
    note: '실제 이메일은 발송되지 않습니다'
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Timelink Development Server',
    endpoints: {
      email: 'POST /api/email/send-verification'
    },
    status: 'online'
  });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log('\n⭐' + '='.repeat(58) + '⭐');
  console.log('🚀 TIMELINK 개발 서버가 시작되었습니다!');
  console.log(`📍 접속 주소: http://localhost:${PORT}`);
  console.log('📧 작동 모드: 개발 모드 (실제 이메일 없음)');
  console.log('💡 사용 방법:');
  console.log('   1. 회원가입 페이지(signup-verification.html) 열기');
  console.log('   2. 이메일 입력 후 "인증 코드 보내기" 클릭');
  console.log('   3. 이 콘솔에서 인증 코드 확인');
  console.log('   4. 확인한 코드를 인증 페이지에 입력');
  console.log('⭐' + '='.repeat(58) + '⭐\n');
});

// ✅ 추가: 프론트엔드가 요청하는 엔드포인트
app.post('/api/email/send-verification', (req, res) => {
  const { email, code } = req.body;
  
  console.log('\n✨' + '='.repeat(50) + '✨');
  console.log('🎯 TIMELINK 인증 시스템');
  console.log('📧 이메일:', email);
  console.log('🔐 인증 코드:', code);
  console.log('✨' + '='.repeat(50) + '✨\n');
  
  res.json({
    success: true,
    message: '개발 모드: 콘솔에서 코드 확인',
    code: code,
    devMode: true
  });
});
