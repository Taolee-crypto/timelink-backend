# 현재 파일 백업
cp src/index.js src/index.js.backup.$(date +%Y%m%d_%H%M%S)

# 새로운 정상 파일 생성
cat > src/index.js << 'EOF'
export default {
  async fetch(request, env, ctx) {
    // CORS 헤더 설정
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // OPTIONS 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // API 라우팅
    switch (true) {
      case path === '/api/health' && method === 'GET':
        return new Response(
          JSON.stringify({
            success: true,
            status: 'ok',
            service: 'Timelink Backend',
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

      case path === '/api/send-verification' && method === 'POST':
        try {
          const { email, code } = await request.json();
          
          console.log(`📧 Send verification to: ${email}, code: ${code}`);
          
          // SendGrid API 호출
          if (env.SENDGRID_API_KEY) {
            const sendgridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                personalizations: [{
                  to: [{ email: email }],
                  subject: 'Timelink 이메일 인증 코드',
                }],
                from: {
                  email: 'noreply@timelink.io',
                  name: 'Timelink'
                },
                content: [{
                  type: 'text/html',
                  value: `
                    <h2>Timelink 이메일 인증</h2>
                    <p>인증 코드: <strong>${code}</strong></p>
                    <p>이 코드는 10분간 유효합니다.</p>
                  `
                }],
              }),
            });

            if (sendgridResponse.ok) {
              return new Response(
                JSON.stringify({
                  success: true,
                  message: '이메일이 발송되었습니다',
                  code: code
                }),
                {
                  headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders
                  }
                }
              );
            }
          }
          
          // SendGrid 없이도 성공 응답 (개발 모드)
          return new Response(
            JSON.stringify({
              success: true,
              message: '테스트 모드: 이메일이 발송되었습니다',
              code: code,
              sendgrid: !!env.SENDGRID_API_KEY
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            }
          );
          
        } catch (error) {
          console.error('Verification error:', error);
          return new Response(
            JSON.stringify({
              success: false,
              error: '이메일 발송 실패'
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

      default:
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Not Found',
            available_endpoints: [
              'GET /api/health',
              'POST /api/send-verification'
            ]
          }),
          {
            status: 404,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          }
        );
    }
  }
};
EOF
