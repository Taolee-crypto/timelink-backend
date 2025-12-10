// src/index.js
export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            
            // CORS 설정
            const corsHeaders = {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            };
            
            // OPTIONS 요청 처리
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders
                });
            }
            
            // API 라우팅
            if (path === '/health') {
                return new Response(JSON.stringify({
                    status: 'ok',
                    service: 'timelink-auth',
                    timestamp: new Date().toISOString()
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        ...corsHeaders
                    }
                });
            }
            
            if (path === '/api/send-verification') {
                return await handleSendVerification(request, env);
            }
            
            if (path === '/api/test') {
                return new Response(JSON.stringify({
                    message: 'API is working',
                    timestamp: new Date().toISOString()
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        ...corsHeaders
                    }
                });
            }
            
            // 404 처리
            return new Response(JSON.stringify({
                error: 'Not Found',
                path: path
            }), {
                status: 404,
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders
                }
            });
            
        } catch (error) {
            console.error('Global error:', error);
            return new Response(JSON.stringify({
                error: 'Internal Server Error',
                message: error.message
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
    }
};

// 간단한 핸들러
async function handleSendVerification(request, env) {
    try {
        // 요청 데이터 파싱
        let data;
        try {
            data = await request.json();
        } catch {
            return new Response(JSON.stringify({
                success: false,
                message: 'Invalid JSON'
            }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        const { email } = data;
        
        if (!email) {
            return new Response(JSON.stringify({
                success: false,
                message: 'Email is required'
            }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        // 인증 코드 생성
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // KV에 저장 (KV가 설정된 경우)
        if (env.VERIFICATIONS) {
            await env.VERIFICATIONS.put(email, JSON.stringify({
                code,
                expiresAt: Date.now() + 600000, // 10분
                createdAt: Date.now()
            }), { expirationTtl: 600 });
        }
        
        // 개발용 로그
        console.log(`Verification code for ${email}: ${code}`);
        
        return new Response(JSON.stringify({
            success: true,
            message: 'Verification code sent (development mode)',
            code: code // 개발용 - 실제 서비스에서는 제거
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
        
    } catch (error) {
        console.error('Send verification error:', error);
        return new Response(JSON.stringify({
            success: false,
            message: 'Internal server error'
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
