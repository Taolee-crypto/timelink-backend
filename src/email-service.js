import sgMail from '@sendgrid/mail';

export function initEmailService(apiKey) {
    sgMail.setApiKey(apiKey);
    
    return {
        sendVerification: async (email, code) => {
            const msg = {
                to: email,
                from: 'noreply@timelink.com',
                subject: 'Timelink 이메일 인증',
                text: `인증 코드: ${code}`,
                html: `<strong>인증 코드: ${code}</strong>`
            };
            
            return sgMail.send(msg);
        }
    };
}
