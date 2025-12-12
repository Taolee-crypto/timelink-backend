// CORS 설정 포함한 Timelink API Worker

export default {
    async fetch(request, env, ctx) {

        // CORS 헤더
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
        };

        // OPTIONS (Preflight)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // -------------------------------
            // 📌 이메일 인증 코드 발송
            // -------------------------------
            if (path === '/api/send-verification' && request.method === 'POST') {

                let data;
                try {
                    data = await request.json();
                } catch (e) {
                    return new Response(
                        JSON.stringify({ success: false, message: 'Invalid JSON' }),
                        {
                            status: 400,
                            headers: { 'Content-Type': 'application/json', ...corsHeaders }
                        }
                    );
                }

                const { email } = data;

                if (!email) {
                    return new Response(
                        JSON.stringify({ success: false, message: 'Email required' }),
                        {
                            status: 400,
                            headers: { 'Content-Type': 'application/json', ...corsHeaders }
                        }
                    );
                }

                // 6자리 코드 생성
                const code = Math.floor(100000 + Math.random() * 900000).toString();

                // KV 저장
                if (env.VERIFICATIONS) {
                    await env.VERIFICATIONS.put(
                        email,
                        JSON.stringify({
                            code,
                            expiresAt: Date.now() + 600000, // 10분
                            createdAt: Date.now()
                        }),
                        { expirationTtl: 600 }
                    );
                }

                console.log(`[SEND CODE] ${email} -> ${code}`);

                return new Response(
                    JSON.stringify({ success: true, message: 'Verification code sent', code }),
                    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
                );
            }

            // -------------------------------
            // 📌 기본 응답
            // -------------------------------
            return new Response(
                JSON.stringify({
                    message: 'Timelink API',
                    endpoints: [
                        '/api/send-verification',
                        '/api/verify-code',
                        '/api/signup'
                    ]
                }),
                { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );

        } catch (err) {
            console.error(err);
            return new Response(
                JSON.stringify({ error: 'Internal server error' }),
                { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
        }
    }
};
