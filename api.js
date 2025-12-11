const express = require('express');
const app = express();

app.use(express.json());

app.post('/api/email/send-verification', (req, res) => {
  console.log('이메일 요청:', req.body);
  // 임시 응답
  res.json({ 
    success: true, 
    message: '개발 모드: 실제 이메일은 발송되지 않습니다.',
    code: req.body.code,
    devMode: true
  });
});

app.listen(3001, () => {
  console.log('서버 실행 중: http://localhost:3001');
});
