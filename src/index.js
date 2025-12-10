export default {
    async fetch(request, env, ctx) {
        // CORS 헤더
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // OPTIONS 요청 처리
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // 라우팅
            if (path === '/' || path === '/health') {
                return jsonResponse({
                    status: 'ok',
                    service: 'timelink-auth',
                    version: '1.0.0'
                }, corsHeaders);
            }

            if (path === '/api/test') {
                return jsonResponse({
                    message: 'API is working',
                    timestamp: new Date().toISOString()
                }, corsHeaders);
            }

            if (path === '/api/send-verification' && request.method === 'POST') {
                return await handleSendVerification(request, env, corsHeaders);
            }

            // 404 처리
            return jsonResponse({
                error: 'Not found',
                path: path
            }, corsHeaders, 404);

        } catch (error) {
            console.error('Error:', error);
            return jsonResponse({
                error: 'Internal server error',
                message: error.message
            }, corsHeaders, 500);
        }
    }
};

// JSON 응답 헬퍼 함수
function jsonResponse(data, headers, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...headers
        }
    });
}

// 이메일 인증 핸들러
async function handleSendVerification(request, env, corsHeaders) {
    try {
        // 요청 데이터 파싱
        const data = await request.json();
        const { email } = data;

        if (!email) {
            return jsonResponse({
                success: false,
                message: 'Email is required'
            }, corsHeaders, 400);
        }

        // 간단한 이메일 형식 검증
        if (!email.includes('@')) {
            return jsonResponse({
                success: false,
                message: 'Invalid email format'
            }, corsHeaders, 400);
        }

        // 인증 코드 생성
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // KV에 저장 (설정된 경우)
        if (env.VERIFICATIONS) {
            await env.VERIFICATIONS.put(email, JSON.stringify({
                code,
                expiresAt: Date.now() + 600000, // 10분
                createdAt: Date.now()
            }), { expirationTtl: 600 });
        }

        // 개발용 로그
        console.log(`[EMAIL VERIFICATION] ${email}: ${code}`);

        return jsonResponse({
            success: true,
            message: 'Verification code generated (development mode)',
            code: code, // 개발용 - 실제 서비스에서는 제거
            expiresIn: 600 // 10분
        }, corsHeaders);

    } catch (error) {
        console.error('Verification error:', error);
        return jsonResponse({
            success: false,
            message: 'Failed to process verification request'
        }, corsHeaders, 500);
    }
}
