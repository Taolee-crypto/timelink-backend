// 실제 이메일 전송 서비스 연동 필요
import { sendEmail } from './email-provider.js';

export async function sendVerificationEmail(email, code) {
    const emailData = {
        to: email,
        subject: 'Timelink 이메일 인증 코드',
        html: `
            <h1>Timelink 이메일 인증</h1>
            <p>인증 코드: <strong>${code}</strong></p>
            <p>이 코드는 10분간 유효합니다.</p>
            <p>타임링크 팀 드림</p>
        `,
        text: `인증 코드: ${code}\n이 코드는 10분간 유효합니다.`
    };
    
    return await sendEmail(emailData);
}
