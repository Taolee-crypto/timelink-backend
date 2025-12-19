// app.js / server.js 파일
const express = require('express');
const app = express();
const emailRoutes = require('./routes/email');

// 미들웨어 설정
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS 설정 (프론트엔드에서 접근 허용)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// 라우트 연결
app.use('/api/email', emailRoutes);

// 기존 다른 라우트들...
// app.use('/api/users', userRoutes);
// app.use('/api/auth', authRoutes);

// 서버 시작
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
