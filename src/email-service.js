const sgMail = require('@sendgrid/mail');

function initSendGrid(apiKey) {
    sgMail.setApiKey(apiKey);
}

async function sendVerificationEmail(to, code) {
    const msg = {
        to,
        from: 'noreply@timelink.com',
        subject: 'Your Verification Code',
        text: `Your code is ${code}`,
    };
    await sgMail.send(msg);
}

module.exports = {
    initSendGrid,
    sendVerificationEmail
};
