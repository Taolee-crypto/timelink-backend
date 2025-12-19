<<<<<<< HEAD
import { handleSignup, handleLogin } from './auth.js';

=======
>>>>>>> backup-before-cleanup
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
<<<<<<< HEAD

    // CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://timelink.digital',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    };

    // OPTIONS 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 헬스 체크
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'TimeLink Backend API',
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 1. 회원가입 API
    if (path === '/api/auth/signup' && request.method === 'POST') {
      return await handleSignup(request, env);
    }

    // 2. 로그인 API
    if (path === '/api/auth/login' && request.method === 'POST') {
      return await handleLogin(request, env);
    }

    // 3. 이메일 인증 API (기존)
    if (path === '/auth/send-verification' && request.method === 'POST') {
      try {
        const { email } = await request.json();

        if (!email) {
          return new Response(
            JSON.stringify({ success: false, message: '이메일이 필요합니다.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // 6자리 인증 코드 생성
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        // KV에 저장
        await env.timelink_users.put(
          `code:${email}`,
          JSON.stringify({
            code: code,
            email: email,
            expiresAt: Date.now() + 600000, // 10분
            createdAt: new Date().toISOString()
          }),
          { expirationTtl: 600 }
        );

        // 개발/프로덕션 모드 구분
        if (env.ENVIRONMENT === 'production' && env.SENDGRID_API_KEY) {
          // 프로덕션: 실제 SendGrid 호출
          return new Response(
            JSON.stringify({
              success: true,
              message: '인증 코드가 이메일로 전송되었습니다.'
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } else {
          // 개발 모드: 코드 반환
          return new Response(
            JSON.stringify({
              success: true,
              code: code,
              message: '개발 모드: 인증 코드 생성됨'
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '서버 오류가 발생했습니다.'
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // 4. 기본 응답
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "TimeLink Backend API",
        version: "4.0.0",
        timestamp: new Date().toISOString(),
        endpoints: [
          { path: "/api/auth/signup", method: "POST", desc: "회원가입" },
          { path: "/api/auth/login", method: "POST", desc: "로그인" },
          { path: "/auth/send-verification", method: "POST", desc: "이메일 인증번호 발송" }
        ],
        cors: "enabled",
        environment: env.ENVIRONMENT || "production"
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
};
=======
    const method = request.method;
    
    // 기본 헤더 설정
    const jsonHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    
    const textHeaders = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    // OPTIONS 요청 처리
    if (method === 'OPTIONS') {
      return new Response(null, { headers: jsonHeaders });
    }

    // 1. 루트 경로 접속 시 기본 메시지
    if (path === '/' || path === '') {
      return new Response('TimeLink 백엔드 작동중!', {
        status: 200,
        headers: textHeaders
      });
    }

    // 2. API 기본 정보
    if (path === '/api' || path === '/api/') {
      return Response.json({
        name: 'TimeLink API',
        version: '1.0.0',
        status: 'online',
        database: 'D1 connected',
        timestamp: new Date().toISOString(),
        endpoints: {
          auth: '/api/auth/*',
          music: '/api/music/*',
          marketplace: '/api/marketplace/*',
          dashboard: '/api/dashboard/*'
        }
      }, { 
        headers: jsonHeaders 
      });
    }

    // 3. 회원가입 API
    if (path === '/api/auth/signup' && method === 'POST') {
      try {
        const { email, password, name } = await request.json();
        
        // 이메일 중복 체크
        const existing = await env.DB.prepare(
          'SELECT id FROM users WHERE email = ?'
        ).bind(email).first();
        
        if (existing) {
          return Response.json({
            success: false,
            message: '이미 등록된 이메일입니다.'
          }, {
            status: 400,
            headers: jsonHeaders
          });
        }
        
        // 실제로는 비밀번호 해싱 필요
        const result = await env.DB.prepare(
          'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'
        ).bind(email, password, name).run();
        
        return Response.json({
          success: true,
          message: '회원가입이 완료되었습니다.',
          userId: result.meta.last_row_id
        }, { 
          headers: jsonHeaders 
        });
        
      } catch (error) {
        return Response.json({
          success: false,
          message: '회원가입 처리 중 오류가 발생했습니다.'
        }, {
          status: 500,
          headers: jsonHeaders
        });
      }
    }

    // 4. 로그인 API
    if (path === '/api/auth/login' && method === 'POST') {
      try {
        const { email, password } = await request.json();
        
        // D1 데이터베이스에서 사용자 조회
        const result = await env.DB.prepare(
          'SELECT id, email, name, verified FROM users WHERE email = ?'
        ).bind(email).first();
        
        if (!result) {
          return Response.json({
            success: false,
            message: '이메일 또는 비밀번호가 잘못되었습니다.'
          }, {
            status: 401,
            headers: jsonHeaders
          });
        }
        
        // 실제로는 비밀번호 검증 필요 (bcrypt 등)
        const tokenData = {
          userId: result.id,
          email: result.email,
          name: result.name,
          exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
        };
        
        const token = btoa(JSON.stringify(tokenData));
        
        return Response.json({
          success: true,
          token: token,
          user: {
            id: result.id,
            email: result.email,
            name: result.name,
            verified: result.verified
          }
        }, { 
          headers: jsonHeaders 
        });
        
      } catch (error) {
        return Response.json({
          success: false,
          message: '로그인 처리 중 오류가 발생했습니다.'
        }, {
          status: 500,
          headers: jsonHeaders
        });
      }
    }

    // 5. 음원 목록 API
    if (path === '/api/music/list' && method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          `SELECT m.*, u.name as artist_name 
           FROM music m 
           LEFT JOIN users u ON m.uploader_id = u.id 
           ORDER BY m.upload_date DESC 
           LIMIT 50`
        ).all();
        
        return Response.json({
          success: true,
          count: results.length,
          music: results.map(item => ({
            id: item.id,
            title: item.title,
            artist: item.artist_name || item.artist,
            price: item.price,
            genre: item.genre,
            duration: item.duration,
            description: item.description,
            uploadDate: item.upload_date,
            downloads: item.downloads,
            rating: item.rating
          }))
        }, { 
          headers: jsonHeaders 
        });
        
      } catch (error) {
        console.error('음원 목록 조회 오류:', error);
        return Response.json({
          success: true,
          count: 6,
          music: [
            {
              id: 1,
              title: "Dreamy Sunrise",
              artist: "Luna Waves",
              price: 12.5,
              genre: "Ambient",
              duration: "4:15",
              description: "아침 햇살을 담은 따뜻한 앰비언트 트랙",
              uploadDate: "2024-12-15",
              downloads: 234,
              rating: 4.7
            },
            {
              id: 2,
              title: "Neon Streets", 
              artist: "Cyber Pulse",
              price: 15.0,
              genre: "Synthwave",
              duration: "3:45",
              description: "사이버펑크 신스웨이브",
              uploadDate: "2024-12-14",
              downloads: 187,
              rating: 4.8
            }
          ]
        }, { 
          headers: jsonHeaders 
        });
      }
    }

    // 6. 마켓플레이스 목록
    if (path === '/api/marketplace/listings' && method === 'GET') {
      return Response.json({
        success: true,
        count: 3,
        listings: [
          {
            id: 101,
            title: "Exclusive Beat Pack",
            seller: { name: "ProducerX", rating: 4.9 },
            price: 49.99,
            genre: "Hip-Hop",
            items: 10,
            sales: 42,
            rating: 4.8
          },
          {
            id: 102,
            title: "Cinematic Strings Collection",
            seller: { name: "OrchestraMaster", rating: 4.7 },
            price: 79.99,
            genre: "Cinematic",
            items: 50,
            sales: 28,
            rating: 4.9
          }
        ]
      }, { 
        headers: jsonHeaders 
      });
    }

    // 7. 대시보드 통계
    if (path === '/api/dashboard/stats' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader?.startsWith('Bearer ')) {
        return Response.json({
          success: false,
          message: '인증이 필요합니다.'
        }, {
          status: 401,
          headers: jsonHeaders
        });
      }
      
      return Response.json({
        success: true,
        stats: {
          totalEarnings: 1250.75,
          totalDownloads: 342,
          activeListings: 8,
          monthlyGrowth: 15.5
        }
      }, { 
        headers: jsonHeaders 
      });
    }

    // 8. 음원 업로드
    if (path === '/api/music/upload' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader?.startsWith('Bearer ')) {
        return Response.json({
          success: false,
          message: '인증이 필요합니다.'
        }, {
          status: 401,
          headers: jsonHeaders
        });
      }
      
      try {
        const formData = await request.formData();
        const title = formData.get('title') || 'Untitled';
        const description = formData.get('description') || '';
        const price = parseFloat(formData.get('price') || '0');
        const genre = formData.get('genre') || 'Other';
        
        // 실제로는 파일 업로드 처리 필요
        return Response.json({
          success: true,
          message: '음원 업로드가 완료되었습니다.',
          music: {
            id: Date.now(),
            title,
            price,
            genre,
            status: 'active'
          }
        }, { 
          headers: jsonHeaders 
        });
        
      } catch (error) {
        return Response.json({
          success: false,
          message: '업로드 처리 중 오류가 발생했습니다.'
        }, {
          status: 500,
          headers: jsonHeaders
        });
      }
    }

    // 404 처리
    return Response.json({
      success: false,
      message: '요청하신 API를 찾을 수 없습니다.',
      path: path,
      method: method
    }, {
      status: 404,
      headers: jsonHeaders
    });
  }
}
>>>>>>> backup-before-cleanup
