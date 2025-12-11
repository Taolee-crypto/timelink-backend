// 기존 코드에 CORS 헤더 추가
export default {
    async fetch(request, env, ctx) {
        // CORS 헤더 설정
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
        };

        // OPTIONS 요청 처리 (Preflight)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // API 엔드포인트 처리
            if (path === '/api/send-verification' && request.method === 'POST') {
                // 요청 데이터 파싱
                let data;
                try {
                    data = await request.json();
                } catch (e) {
                    return new Response(
                        JSON.stringify({ success: false, message: 'Invalid JSON' }),
                        {
                            status: 400,
                            headers: {
                                'Content-Type': 'application/json',
                                ...corsHeaders
                            }
                        }
                    );
                }

                const { email } = data;

                if (!email) {
                    return new Response(
                        JSON.stringify({ success: false, message: 'Email required' }),
                        {
                            status: 400,
                            headers: {
                                'Content-Type': 'application/json',
                                ...corsHeaders
                            }
                        }
                    );
                }

                // 인증 코드 생성
                const code = Math.floor(100000 + Math.random() * 900000).toString();
                
                // KV에 저장
                if (env.VERIFICATIONS) {
                    await env.VERIFICATIONS.put(email, JSON.stringify({
                        code,
                        expiresAt: Date.now() + 600000,
                        createdAt: Date.now()
                    }), { expirationTtl: 600 });
                }

                console.log(`[EMAIL] ${email}: ${code}`);

                return new Response(
                    JSON.stringify({
                        success: true,
                        message: 'Verification code sent',
                        code: code // 개발용
                    }),
                    {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            ...corsHeaders
                        }
                    }
                );
            }

            // 기본 응답
            return new Response(
                JSON.stringify({
                    message: 'Timelink API',
                    endpoints: ['/api/send-verification', '/api/verify-code', '/api/signup']
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        ...corsHeaders
                    }
                }
            );

        } catch (error) {
            console.error('Error:', error);
            return new Response(
                JSON.stringify({ error: 'Internal server error' }),
                {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        ...corsHeaders
                    }
                }
            );
        }
    }
};
