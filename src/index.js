export default {
    async fetch(request, env, ctx) {
        // 1. CORS 헤더 설정
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };
        
        // 2. OPTIONS 요청 처리 (CORS preflight)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }
        
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            
            // 3. API 라우팅
            if (path === '/health' || path === '/') {
                return new Response(
                    JSON.stringify({
                        status: 'ok',
                        service: 'timelink-auth',
                        timestamp: new Date().toISOString()
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
            
            if (path === '/api/test') {
                return new Response(
                    JSON.stringify({
                        message: 'Test endpoint working',
                        data: { test: 'success' }
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
            
            if (path === '/api/send-verification' && request.method === 'POST') {
                // 요청 데이터 읽기
                let body;
                try {
                    body = await request.json();
                } catch (e) {
                    return new Response(
                        JSON.stringify({
                            success: false,
                            message: 'Invalid JSON'
                        }),
                        {
                            status: 400,
                            headers: {
                                'Content-Type': 'application/json',
                                ...corsHeaders
                            }
                        }
                    );
                }
                
                const { email } = body;
                
                if (!email) {
                    return new Response(
                        JSON.stringify({
                            success: false,
                            message: 'Email is required'
                        }),
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
                
                // 로그 출력
                console.log(`Verification code for ${email}: ${code}`);
                
                return new Response(
                    JSON.stringify({
                        success: true,
                        message: 'Verification code generated',
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
            
            // 4. 404 처리
            return new Response(
                JSON.stringify({
                    error: 'Not Found',
                    path: path,
                    method: request.method
                }),
                {
                    status: 404,
                    headers: {
                        'Content-Type': 'application/json',
                        ...corsHeaders
                    }
                }
            );
            
        } catch (error) {
            // 5. 에러 처리
            console.error('Global error:', error);
            return new Response(
                JSON.stringify({
                    error: 'Internal Server Error',
                    message: error.message
                }),
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
