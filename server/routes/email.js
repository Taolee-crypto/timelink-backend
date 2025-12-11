// routes/email.js 또는 app.js/routes 부분
const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');

// SendGrid API 키 설정 (환경변수에서 가져오는 것이 안전)
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// 이메일 인증 코드 발송 API
router.post('/send-verification', async (req, res) => {
  try {
    const { email, code } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ 
        success: false, 
        message: '이메일과 인증 코드가 필요합니다.' 
      });
    }
    
    const msg = {
      to: email,
      from: {
        email: 'noreply@timelink.digital',
        name: 'Timelink'
      },
      subject: '[Timelink] 이메일 인증 코드',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6C63FF;">Timelink 이메일 인증</h2>
          <p>안녕하세요! 회원가입을 완료하려면 아래 인증 코드를 입력해주세요.</p>
          <div style="background: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0; border-radius: 10px;">
            <h3 style="color: #333; font-size: 32px; letter-spacing: 10px; margin: 0;">${code}</h3>
          </div>
          <p>이 코드는 10분 동안 유효합니다.</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">
            본인이 요청한 것이 아니라면 이 메일을 무시하세요.<br>
            © 2024 Timelink. All rights reserved.
          </p>
        </div>
      `
    };
    
    await sgMail.send(msg);
    
    console.log(`✅ 이메일 발송 성공: ${email}, 코드: ${code}`);
    res.json({ 
      success: true, 
      message: '이메일이 발송되었습니다.',
      code: code // 개발용으로 코드 반환
    });
    
  } catch (error) {
    console.error('❌ 이메일 발송 실패:', error);
    
    // 개발 모드: 실제 발송 실패해도 코드는 반환
    if (process.env.NODE_ENV === 'development') {
      console.log(`⚠️ 개발 모드: ${req.body.email}에게 발송될 코드는 ${req.body.code}입니다.`);
      return res.json({ 
        success: false, 
        message: '개발 모드: 실제 이메일은 발송되지 않았습니다.',
        code: req.body.code,
        devMode: true
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: '이메일 발송 중 오류가 발생했습니다.' 
    });
  }
});

module.exports = router;
