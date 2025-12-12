// CORS 설정 포함한 Timelink API Worker

// CORS 헤더
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
};

// Helper: OPTIONS 요청 처리
function handleOptionsRequest() {
    return new Response(null, {
        status: 204,
        headers: corsHeaders,
    });
}

// Helper: JSON 응답
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

// Worker entry point
export async function fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
        return handleOptionsRequest();
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
                return jsonResponse({ success: false, message: 'Invalid JSON' }, 400);
            }

            const { email } = data;
            if (!email) {
                return jsonResponse({ success: false, message: 'Email required' }, 400);
            }

            // 6자리 인증 코드 생성
            const code = Math.floor(100000 + Math.random() * 900000).toString();

            // KV 저장
            if (env.VERIFICATIONS) {
                await env.VERIFICATIONS.put(
                    email,
                    JSON.stringify({
                        code,
                        expiresAt: Date.now() + 600000, // 10분
                        createdAt: Date.now(),
                    }),
                    { expirationTtl: 600 }
                );
            }

            console.log(`[SEND CODE] ${email} -> ${code}`);

            return jsonResponse({
                success: true,
                message: 'Verification code sent',
                code,
            });
        }

        // -------------------------------
        // 📌 기본 응답
        // -------------------------------
        return jsonResponse({
            message: 'Timelink API',
            endpoints: [
                '/api/send-verification',
                '/api/verify-code',
                '/api/signup',
            ],
        });
    } catch (err) {
        console.error(err);
        return jsonResponse({ error: 'Internal server error' }, 500);
    }
}
