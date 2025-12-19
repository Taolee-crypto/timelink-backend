const express = require('express');
const sgMail = require('@sendgrid/mail');
require('dotenv').config();

const app = express();
app.use(express.json());

// CORS 허용
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 테스트용 루트 페이지
app.get('/', (req, res) => {
  res.json({ message: 'Timelink Email Server', status: 'online' });
});

// SendGrid 설정
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// 이메일 발송 API
app.post('/api/email/send-verification', async (req, res) => {
  console.log('📧 Received:', req.body.email, 'Code:', req.body.code);
  
  try {
    const msg = {
      to: req.body.email,
      from: 'noreply@timelink.digital',
      subject: 'Timelink Verification Code',
      text: `Your code: ${req.body.code}`
    };
    
    await sgMail.send(msg);
    console.log('✅ Email sent successfully');
    res.json({ success: true, message: 'Email sent' });
    
  } catch (error) {
    console.error('❌ SendGrid error:', error.message);
    res.json({ 
      success: false, 
      message: 'Dev mode: email not sent',
      code: req.body.code,
      devMode: true 
    });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 SERVER RUNNING: http://localhost:${PORT}`);
  console.log(`📧 SendGrid API key is set`);
});
