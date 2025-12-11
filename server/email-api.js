const express = require('express');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ✅ 프론트엔드가 호출하는 정확한 엔드포인트
app.post('/api/email/send-verification', (req, res) => {
  const { email, code } = req.body;
  
  console.log('\n' + '⭐'.repeat(60));
  console.log('🚀 이메일 인증 요청 도착!');
  console.log('📧 수신 이메일:', email);
  console.log('🔐 인증 코드:', code);
  console.log('💡 이 코드를 웹페이지에 입력하세요!');
  console.log('⭐'.repeat(60) + '\n');
  
  res.json({
    success: true,
    message: '개발 모드: 코드는 콘솔에 출력됨',
    code: code,
    devMode: true,
    timestamp: new Date().toISOString()
  });
});

// 루트 페이지
app.get('/', (req, res) => {
  res.json({
    service: 'Timelink Email API Server',
    endpoint: 'POST /api/email/send-verification',
    status: 'online',
    note: '개발 모드 - 실제 이메일 없음'
  });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log('\n✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅');
  console.log('✅ TIMELINK 이메일 API 서버 시작됨!');
  console.log(`✅ 주소: http://localhost:${PORT}`);
  console.log('✅ 엔드포인트: POST /api/email/send-verification');
  console.log('✅ 프론트엔드와 연동 가능 상태');
  console.log('✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅\n');
});
