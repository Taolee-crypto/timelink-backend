// tIMELINK 프로덕션 백엔드 메인 엔트리 포인트
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      
      // CORS 헤더 설정 (프론트엔드 도메인 허용)
      const allowedOrigins = [
        'https://timelink.digital',
        'https://www.timelink.digital',
        'http://localhost:3000',
        'http://localhost:5173'
      ];
      
      const origin = request.headers.get('Origin');
      const corsHeaders = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      };
      
      if (origin && allowedOrigins.includes(origin)) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
      } else {
        corsHeaders['Access-Control-Allow-Origin'] = '*';
      }
      
      // Preflight 요청 처리
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders
        });
      }
      
      // API 라우팅
      switch (true) {
        case (path === '/api/health' || path === '/health') && method === 'GET':
          return this.jsonResponse({
            status: 'healthy',
            service: 'tIMELINK Production Backend',
            version: '1.0.0',
            environment: 'production',
            timestamp: new Date().toISOString(),
            features: {
              authentication: true,
              file_processing: true,
              time_credits: true,
              email_service: !!env.SENDGRID_API_KEY,
              database: !!env.timelink_users
            }
          }, corsHeaders);
          
        case path === '/api/test' && method === 'GET':
          try {
            const dbTest = await env.timelink_users.prepare(
              'SELECT 1 as test, datetime() as db_time, COUNT(*) as user_count FROM users'
            ).first();
            
            return this.jsonResponse({
              success: true,
              message: 'Production system operational',
              database: dbTest,
              environment: 'production',
              secrets_configured: {
                sendgrid: !!env.SENDGRID_API_KEY,
                jwt: !!env.JWT_SECRET
              }
            }, corsHeaders);
          } catch (dbError) {
            console.error('Database error:', dbError);
            return this.jsonResponse({
              success: false,
              error: 'Database connection issue',
              environment: 'production'
            }, corsHeaders, 500);
          }
          
        case path === '/api/register' && method === 'POST':
          return await this.handleRegister(request, env, corsHeaders);
          
        case path === '/api/login' && method === 'POST':
          return await this.handleLogin(request, env, corsHeaders);
          
        case path === '/api/upload' && method === 'POST':
          return await this.handleFileUpload(request, env, corsHeaders);
          
        case path === '/api/send-verification' && method === 'POST':
          return await this.handleSendVerification(request, env, corsHeaders);
          
        case path === '/api/wallet/balance' && method === 'GET':
          return await this.handleWalletBalance(request, env, corsHeaders);
          
        case path === '/api/convert' && method === 'POST':
          return await this.handleFileConvert(request, env, corsHeaders);
          
        default:
          return this.jsonResponse({
            api: 'tIMELINK Digital Asset Platform',
            status: 'production',
            version: '1.0.0',
            environment: 'production',
            endpoints: {
              health: 'GET /api/health',
              test: 'GET /api/test',
              register: 'POST /api/register',
              login: 'POST /api/login',
              upload: 'POST /api/upload',
              verify_email: 'POST /api/send-verification',
              wallet_balance: 'GET /api/wallet/balance',
              convert: 'POST /api/convert'
            },
            documentation: 'https://github.com/Taolee-crypto/timelink-backend',
            support: 'Contact system administrator',
            timestamp: new Date().toISOString()
          }, corsHeaders);
      }
    } catch (error) {
      console.error('Production error:', error);
      return this.jsonResponse({
        error: 'Internal Server Error',
        message: 'Please contact support',
        timestamp: new Date().toISOString()
      }, {}, 500);
    }
  },
  
  // JSON 응답 헬퍼
  jsonResponse(data, headers = {}, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    });
  },
  
  // 회원가입 처리
  async handleRegister(request, env, corsHeaders) {
    try {
      const data = await request.json();
      const { email, password, username } = data;
      
      if (!email || !password) {
        return this.jsonResponse({
          error: 'Email and password are required'
        }, corsHeaders, 400);
      }
      
      // 이메일 중복 체크
      const existingUser = await env.timelink_users.prepare(
        'SELECT id FROM users WHERE email = ?'
      ).bind(email).first();
      
      if (existingUser) {
        return this.jsonResponse({
          error: 'Email already registered'
        }, corsHeaders, 409);
      }
      
      // 비밀번호 해시화 (간단한 예제 - 실제로는 bcrypt 사용)
      const passwordHash = await this.hashPassword(password);
      const userId = `usr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      
      // 사용자 저장
      await env.timelink_users.prepare(
        `INSERT INTO users (id, email, password_hash, username, verification_code, 
         verification_expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', '+10 minutes'), 'pending', datetime('now'))`
      ).bind(
        userId,
        email,
        passwordHash,
        username || null,
        verificationCode
      ).run();
      
      // 이메일 발송 (SendGrid)
      if (env.SENDGRID_API_KEY) {
        await this.sendVerificationEmail(email, verificationCode, env.SENDGRID_API_KEY);
      }
      
      return this.jsonResponse({
        success: true,
        message: 'Registration successful. Please verify your email.',
        userId,
        email_sent: !!env.SENDGRID_API_KEY,
        verification_required: true
      }, corsHeaders, 201);
      
    } catch (error) {
      console.error('Registration error:', error);
      return this.jsonResponse({
        error: 'Registration failed',
        details: 'Please try again later'
      }, corsHeaders, 500);
    }
  },
  
  // 로그인 처리
  async handleLogin(request, env, corsHeaders) {
    try {
      const data = await request.json();
      const { email, password } = data;
      
      if (!email || !password) {
        return this.jsonResponse({
          error: 'Email and password are required'
        }, corsHeaders, 400);
      }
      
      // 사용자 조회
      const user = await env.timelink_users.prepare(
        'SELECT * FROM users WHERE email = ?'
      ).bind(email).first();
      
      if (!user) {
        return this.jsonResponse({
          error: 'Invalid credentials'
        }, corsHeaders, 401);
      }
      
      // 비밀번호 검증 (간단한 해시 비교)
      const passwordValid = await this.verifyPassword(password, user.password_hash);
      if (!passwordValid) {
        return this.jsonResponse({
          error: 'Invalid credentials'
        }, corsHeaders, 401);
      }
      
      // 계정 상태 확인
      if (user.status !== 'active') {
        return this.jsonResponse({
          error: 'Account not active. Please verify your email.',
          needs_verification: true
        }, corsHeaders, 403);
      }
      
      // JWT 토큰 생성 (간단한 버전)
      const token = this.generateJWT(user, env.JWT_SECRET);
      
      // 로그인 시간 업데이트
      await env.timelink_users.prepare(
        'UPDATE users SET last_login = datetime("now") WHERE id = ?'
      ).bind(user.id).run();
      
      return this.jsonResponse({
        success: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          time_credits: user.time_credits || 0
        },
        expires_in: '24h'
      }, corsHeaders);
      
    } catch (error) {
      console.error('Login error:', error);
      return this.jsonResponse({
        error: 'Login failed'
      }, corsHeaders, 500);
    }
  },
  
  // 파일 업로드 처리
  async handleFileUpload(request, env, corsHeaders) {
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      const metadata = formData.get('metadata');
      
      if (!file) {
        return this.jsonResponse({
          error: 'No file provided'
        }, corsHeaders, 400);
      }
      
      // tIMELINK 파일 처리 로직
      const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const tl3Hash = `tl3_${Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('')}`;
      
      // 파일 정보 저장
      await env.timelink_users.prepare(
        `INSERT INTO tl_files (id, user_id, tl3_hash, file_name, file_size, 
         file_type, metadata_json, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        fileId,
        'demo_user_id', // 실제로는 JWT 토큰에서 사용자 ID 추출
        tl3Hash,
        file.name,
        file.size,
        file.type,
        metadata || '{}'
      ).run();
      
      return this.jsonResponse({
        success: true,
        message: 'File uploaded successfully',
        file: {
          id: fileId,
          tl3_hash: tl3Hash,
          name: file.name,
          size: file.size,
          type: file.type,
          uploaded_at: new Date().toISOString()
        },
        next_steps: 'File will be processed and converted to .tl.mp3 format'
      }, corsHeaders, 201);
      
    } catch (error) {
      console.error('Upload error:', error);
      return this.jsonResponse({
        error: 'File upload failed'
      }, corsHeaders, 500);
    }
  },
  
  // 이메일 인증 코드 발송
 async handleSendVerification(request, env, corsHeaders) {
  console.error('=== handleSendVerification 진입 ===');
  console.error('env.SENDGRID_API_KEY:', !!env.SENDGRID_API_KEY);
  console.error('env.SENDGRID_API_KEY 타입:', typeof env.SENDGRID_API_KEY);
  console.error('env.SENDGRID_API_KEY 값 (처음 10자):', 
    env.SENDGRID_API_KEY ? env.SENDGRID_API_KEY.substring(0, 10) + '...' : '없음');
  
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      
      // 코드 저장
      await env.timelink_users.prepare(
        `UPDATE users SET verification_code = ?, 
         verification_expires_at = datetime('now', '+10 minutes')
         WHERE email = ?`
      ).bind(verificationCode, email).run();
      
      // 이메일 발송
      const emailSent = await this.sendVerificationEmail(email, verificationCode, env.SENDGRID_API_KEY);
      
      return this.jsonResponse({
        success: emailSent,
        message: emailSent ? 'Verification email sent' : 'Failed to send email',
        email: email
      }, corsHeaders);
      
    } catch (error) {
      console.error('Verification error:', error);
      return this.jsonResponse({
        error: 'Failed to send verification'
      }, corsHeaders, 500);
    }
  },
  
  // 지갑 잔액 확인
  async handleWalletBalance(request, env, corsHeaders) {
    try {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return this.jsonResponse({
          error: 'Authorization token required'
        }, corsHeaders, 401);
      }
      
      // 토큰에서 사용자 ID 추출 (간단한 예제)
      const token = authHeader.split(' ')[1];
      // 실제로는 JWT 토큰 디코딩 로직 필요
      
      // 임시 사용자 ID
      const userId = 'demo_user_id';
      
      const user = await env.timelink_users.prepare(
        'SELECT time_credits FROM users WHERE id = ?'
      ).bind(userId).first();
      
      return this.jsonResponse({
        success: true,
        balance: user?.time_credits || 0,
        currency: 'TL',
        last_updated: new Date().toISOString()
      }, corsHeaders);
      
    } catch (error) {
      console.error('Wallet balance error:', error);
      return this.jsonResponse({
        error: 'Failed to get wallet balance'
      }, corsHeaders, 500);
    }
  },
  
  // 파일 변환 처리 (.tl.mp3 변환)
  async handleFileConvert(request, env, corsHeaders) {
    try {
      const data = await request.json();
      const { fileId, metadata } = data;
      
      if (!fileId) {
        return this.jsonResponse({
          error: 'File ID is required'
        }, corsHeaders, 400);
      }
      
      // tIMELINK 6계층 메타데이터 생성 시뮬레이션
      const tlMetadata = {
        layer1: { ownerId: 'user_id', timestamp: new Date().toISOString() },
        layer2: { copyright: 'copyright info', license: 'TL License' },
        layer3: { total_time: 3600, remaining_time: 3600 },
        layer4: { playback_logs: [] },
        layer5: { settlement_ratio: '50:50' },
        layer6: { hash: 'sha256_hash_here', signature: 'owner_signature' }
      };
      
      return this.jsonResponse({
        success: true,
        message: 'File conversion to .tl.mp3 started',
        file_id: fileId,
        tl3_hash: `tl3_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        metadata: tlMetadata,
        estimated_completion: new Date(Date.now() + 30000).toISOString() // 30초 후
      }, corsHeaders);
      
    } catch (error) {
      console.error('File conversion error:', error);
      return this.jsonResponse({
        error: 'File conversion failed'
      }, corsHeaders, 500);
    }
  },
  
  // ===== 유틸리티 함수들 =====
  
  // 비밀번호 해시화
  async hashPassword(password) {
    // 간단한 SHA-256 해시 (실제 운영에서는 bcrypt 권장)
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },
  
  // 비밀번호 검증
  async verifyPassword(password, hash) {
    const hashedPassword = await this.hashPassword(password);
    return hashedPassword === hash;
  },
  
  // 이메일 발송 함수
async sendVerificationEmail(to, code, apiKey) {
  console.error('🔍 [DEBUG] SendGrid 함수 시작');
  console.error(`🔍 [DEBUG] 수신자: ${to}, 코드: ${code}`);
  console.error(`🔍 [DEBUG] API 키 존재: ${!!apiKey}`);
  
  if (!apiKey) {
    console.error('❌ [ERROR] SendGrid API 키가 없습니다!');
    return false;
  }
  
  console.error(`🔍 [DEBUG] API 키 앞 10자: ${apiKey.substring(0, 10)}...`);
  
  try {
    const emailData = {
      personalizations: [{
        to: [{ email: to }],
        subject: 'tIMELINK 이메일 인증 코드'
      }],
      from: {
        email: '인증된_이메일@주소', // ⚠️ 여기를 SendGrid 인증 주소로 변경!
        name: 'tIMELINK'
      },
      content: [{
        type: 'text/html',
        value: `<div>인증 코드: ${code}</div>`
      }]
    };
    
    console.error('🔍 [DEBUG] SendGrid 요청 보내는 중...');
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailData)
    });
    
    console.error(`🔍 [DEBUG] SendGrid 응답 상태: ${response.status}`);
    
    const responseText = await response.text();
    console.error(`🔍 [DEBUG] SendGrid 응답: ${responseText}`);
    
    if (!response.ok) {
      console.error(`❌ [ERROR] SendGrid 오류: ${response.status}`);
      console.error(`❌ [ERROR] 상세: ${responseText}`);
    }
    
    return response.ok;
    
  } catch (error) {
    console.error(`❌ [EXCEPTION] 오류 발생: ${error.message}`);
    return false;
  }
}
  // JWT 토큰 생성 (간단한 버전)
  generateJWT(user, secret) {
    // 실제로는 jsonwebtoken 라이브러리 사용 권장
    if (!secret) return 'demo_token_not_configured';
    
    const header = Buffer.from(JSON.stringify({
      alg: 'HS256',
      typ: 'JWT'
    })).toString('base64');
    
    const payload = Buffer.from(JSON.stringify({
      userId: user.id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24시간
    })).toString('base64');
    
    // 실제로는 secret으로 서명
    const signature = 'signed_with_' + secret.substring(0, 10);
    
    return `${header}.${payload}.${signature}`;
  }
};
