const emailService = require('./email-service');

module.exports = {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);

        if (url.pathname === '/api/send-verification' && request.method === 'POST') {
            let data;
            try {
                data = await request.json();
            } catch (e) {
                return new Response(JSON.stringify({ success: false, message: 'Invalid JSON' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }

            const { email } = data;
            if (!email) {
                return new Response(JSON.stringify({ success: false, message: 'Email required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }

            const code = Math.floor(100000 + Math.random() * 900000).toString();

            // KV 저장
            if (env.VERIFICATIONS) {
                await env.VERIFICATIONS.put(
                    email,
                    JSON.stringify({ code, expiresAt: Date.now() + 600000 }),
                    { expirationTtl: 600 }
                );
            }

            // SendGrid 전송
            emailService.initSendGrid(env.SENDGRID_API_KEY);
            await emailService.sendVerificationEmail(email, code);

            return new Response(JSON.stringify({ success: true, message: 'Verification code sent', code }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        return new Response(JSON.stringify({ message: 'Timelink API' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
};
