export default {
    async fetch(request, env, ctx) {
        // CORS 설정
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // API 라우팅
            switch(path) {
                case '/api/send-verification':
                    return await handleSendVerification(request, env);
                case '/api/verify-code':
                    return await handleVerifyCode(request, env);
                case '/api/signup':
                    return await handleSignup(request, env);
                case '/api/login':
                    return await handleLogin(request, env);
                case '/api/check-email':
                    return await handleCheckEmail(request, env);
                case '/health':
                    return jsonResponse({ status: 'ok', service: 'timelink-auth' });
                default:
                    return jsonResponse({ error: 'Not found' }, 404);
            }
        } catch (error) {
            console.error('API Error:', error);
            return jsonResponse({ error: 'Internal server error' }, 500);
        }
    }
};

// 실제 구현 함수들...
