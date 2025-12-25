// worker.js - TimeLink 완전한 API 시스템 (인증 + 프로필 관리)
export default {
  async fetch(request, env, ctx) {
    console.log("🔍 TimeLink API 요청:", request.method, request.url);
    
    const url = new URL(request.url);
    const db = env.TL_DB;
    const kvSessions = env.TL_SESSIONS;
    
    // CORS 헤더 설정
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "86400",
    };
    
    // OPTIONS 요청 처리
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    
    // ==================== 인증 헬퍼 함수 ====================
    async function authenticate(request) {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
      }
      
      const token = authHeader.substring(7);
      
      try {
        // KV에서 세션 확인
        const sessionData = await kvSessions.get(token);
        if (!sessionData) {
          console.log("❌ 세션 없음 또는 만료됨");
          return null;
        }
        
        const session = JSON.parse(sessionData);
        
        // 사용자 정보 추가 확인
        const user = await db.prepare(
          "SELECT id, email, nickname, real_name, phone, balance, email_verified FROM users WHERE id = ?"
        ).bind(session.userId).first();
        
        if (!user) {
          console.log("❌ 사용자 DB에 없음");
          return null;
        }
        
        return {
          token,
          userId: session.userId,
          email: user.email,
          userData: user
        };
        
      } catch (error) {
        console.error("인증 오류:", error);
        return null;
      }
    }
    
    // ==================== API 라우팅 ====================
    
    // 1. 기본 정보
    if (url.pathname === "/" || url.pathname === "/api") {
      return new Response(
        JSON.stringify({
          service: "TimeLink API v3.0",
          message: "디지털 시대의 시간 경제",
          version: "3.0.0",
          status: "operational",
          timestamp: new Date().toISOString(),
          endpoints: {
            auth: {
              signup: "POST /api/auth/signup",
              login: "POST /api/auth/login",
              verify: "GET /api/auth/verify?token={token}",
              logout: "POST /api/auth/logout"
            },
            profile: {
              get: "GET /api/auth/profile",
              update: "PUT /api/auth/profile",
              changePassword: "PUT /api/auth/change-password"
            },
            music: "/api/music/*",
            marketplace: "/api/marketplace/*"
          }
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    
    // 2. 회원가입 API
    if (url.pathname === "/api/auth/signup" && request.method === "POST") {
      try {
        console.log("📝 회원가입 요청 처리 시작");
        const body = await request.text();
        console.log("📦 요청 본문:", body);
        
        let data;
        try {
          data = JSON.parse(body);
          console.log("✅ JSON 파싱 성공");
        } catch (e) {
          console.log("❌ JSON 파싱 실패:", e.message);
          return new Response(
            JSON.stringify({ error: "잘못된 JSON 형식입니다" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 필드 검증
        if (!data.email || !data.password || !data.name) {
          console.log("🚨 필드 누락");
          return new Response(
            JSON.stringify({ 
              error: "이메일, 비밀번호, 이름을 모두 입력해주세요."
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 이메일 형식 검증
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(data.email)) {
          console.log("🚨 이메일 형식 오류");
          return new Response(
            JSON.stringify({ error: "유효한 이메일 주소를 입력해주세요." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 비밀번호 길이 검증
        if (data.password.length < 6) {
          console.log("🚨 비밀번호 너무 짧음");
          return new Response(
            JSON.stringify({ error: "비밀번호는 6자 이상이어야 합니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 중복 이메일 체크
        console.log("🔎 중복 이메일 체크:", data.email);
        const existingUser = await db.prepare(
          "SELECT id FROM users WHERE email = ?"
        ).bind(data.email).first();
        
        if (existingUser) {
          console.log("❌ 이미 존재하는 이메일");
          return new Response(
            JSON.stringify({ error: "이미 사용 중인 이메일입니다." }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 비밀번호 해싱
        const passwordHash = await hashPassword(data.password);
        
        // 인증 코드 생성
        const verificationCode = generateVerificationCode();
        const createdAt = new Date().toISOString();
        
        // 사용자 데이터베이스에 저장
        console.log("💾 사용자 데이터베이스 저장 중...");
        try {
          const result = await db.prepare(
            `INSERT INTO users (
              email, 
              password_hash, 
              nickname, 
              real_name, 
              verification_code,
              email_verified,
              balance,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            data.email,
            passwordHash,
            data.name,
            data.name,
            verificationCode,
            0,
            0,
            createdAt
          ).run();
          
          console.log("✅ 데이터베이스 저장 성공:", result);
          
        } catch (dbError) {
          console.error("💥 데이터베이스 오류:", dbError);
          return new Response(
            JSON.stringify({ error: "데이터베이스 저장 중 오류가 발생했습니다." }),
            { status: 500, headers: corsHeaders }
          );
        }
        
        // 이메일 발송
        try {
          await sendVerificationEmail(data.email, verificationCode, env);
          console.log("📧 이메일 발송 성공");
        } catch (emailError) {
          console.log("⚠️ 이메일 발송 실패 (사용자는 저장됨):", emailError.message);
        }
        
        console.log("🎉 회원가입 완료!");
        return new Response(
          JSON.stringify({
            success: true,
            message: "회원가입이 완료되었습니다. 이메일을 확인해주세요.",
            data: {
              email: data.email,
              name: data.name,
              registered: true,
              needs_verification: true
            }
          }),
          {
            status: 201,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
        
      } catch (error) {
        console.error("💥 서버 오류:", error);
        return new Response(
          JSON.stringify({ error: "서버 오류가 발생했습니다." }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 3. 로그인 API
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      try {
        console.log("🔐 로그인 요청");
        const data = await request.json();
        
        if (!data.email || !data.password) {
          return new Response(
            JSON.stringify({ error: "이메일과 비밀번호를 입력해주세요." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 사용자 조회
        const user = await db.prepare(
          `SELECT id, email, password_hash, email_verified, nickname, real_name, phone, balance
           FROM users WHERE email = ?`
        ).bind(data.email).first();
        
        if (!user) {
          console.log("❌ 사용자 없음:", data.email);
          return new Response(
            JSON.stringify({ error: "이메일 또는 비밀번호가 일치하지 않습니다." }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 비밀번호 검증
        const isValidPassword = await verifyPassword(data.password, user.password_hash);
        if (!isValidPassword) {
          console.log("❌ 비밀번호 불일치");
          return new Response(
            JSON.stringify({ error: "이메일 또는 비밀번호가 일치하지 않습니다." }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 이메일 인증 확인 (선택사항 - 주석 해제하여 활성화)
        // if (!user.email_verified) {
        //   return new Response(
        //     JSON.stringify({ error: "이메일 인증이 필요합니다." }),
        //     { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }
        
        // 세션 토큰 생성 및 저장
        const sessionToken = generateSessionToken();
        const sessionData = {
          userId: user.id,
          email: user.email,
          loggedInAt: new Date().toISOString(),
          lastActive: new Date().toISOString()
        };
        
        // KV에 세션 저장 (7일 유효)
        await kvSessions.put(sessionToken, JSON.stringify(sessionData), {
          expirationTtl: 60 * 60 * 24 * 7
        });
        
        console.log("✅ 로그인 성공:", user.email);
        return new Response(
          JSON.stringify({
            success: true,
            message: "로그인 성공",
            user: {
              id: user.id,
              email: user.email,
              nickname: user.nickname,
              real_name: user.real_name,
              phone: user.phone,
              balance: user.balance,
              verified: user.email_verified
            },
            token: sessionToken
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (error) {
        console.error("💥 로그인 오류:", error);
        return new Response(
          JSON.stringify({ error: "로그인 처리 중 오류가 발생했습니다." }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // ==================== 프로필 관리 API ====================
    
    // 4. 프로필 조회 API
    if (url.pathname === "/api/auth/profile" && request.method === "GET") {
      const auth = await authenticate(request);
      if (!auth) {
        return new Response(
          JSON.stringify({ error: "인증이 필요합니다." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        console.log("👤 프로필 조회:", auth.userId);
        
        // 세션 갱신
        await updateSessionLastActive(auth.token, kvSessions);
        
        return new Response(
          JSON.stringify({
            success: true,
            message: "프로필 정보 조회 성공",
            profile: {
              id: auth.userData.id,
              email: auth.userData.email,
              nickname: auth.userData.nickname,
              real_name: auth.userData.real_name,
              phone: auth.userData.phone || "",
              balance: auth.userData.balance,
              email_verified: auth.userData.email_verified,
              joined_at: await getUserJoinedDate(auth.userId, db)
            },
            stats: await getUserStats(auth.userId, db)
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (error) {
        console.error("💥 프로필 조회 오류:", error);
        return new Response(
          JSON.stringify({ error: "프로필 조회 중 오류가 발생했습니다." }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 5. 프로필 수정 API
    if (url.pathname === "/api/auth/profile" && request.method === "PUT") {
      const auth = await authenticate(request);
      if (!auth) {
        return new Response(
          JSON.stringify({ error: "인증이 필요합니다." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        console.log("✏️ 프로필 수정 요청:", auth.userId);
        const data = await request.json();
        
        // 업데이트할 필드 확인
        const updates = {};
        const allowedFields = ["nickname", "real_name", "phone"];
        
        allowedFields.forEach(field => {
          if (data[field] !== undefined && data[field] !== null) {
            updates[field] = data[field];
          }
        });
        
        if (Object.keys(updates).length === 0) {
          return new Response(
            JSON.stringify({ error: "수정할 정보가 없습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 업데이트 쿼리 생성
        const setClause = Object.keys(updates).map(field => `${field} = ?`).join(", ");
        const values = Object.values(updates);
        values.push(auth.userId);
        
        const result = await db.prepare(
          `UPDATE users SET ${setClause} WHERE id = ?`
        ).bind(...values).run();
        
        if (result.changes === 0) {
          console.log("⚠️ 프로필 수정 실패 (변경사항 없음)");
        }
        
        // 세션 갱신
        await updateSessionLastActive(auth.token, kvSessions);
        
        // 업데이트된 사용자 정보 조회
        const updatedUser = await db.prepare(
          "SELECT nickname, real_name, phone FROM users WHERE id = ?"
        ).bind(auth.userId).first();
        
        console.log("✅ 프로필 수정 성공");
        return new Response(
          JSON.stringify({
            success: true,
            message: "프로필이 성공적으로 수정되었습니다.",
            updated_fields: Object.keys(updates),
            profile: updatedUser
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (error) {
        console.error("💥 프로필 수정 오류:", error);
        return new Response(
          JSON.stringify({ error: "프로필 수정 중 오류가 발생했습니다." }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 6. 비밀번호 변경 API
    if (url.pathname === "/api/auth/change-password" && request.method === "PUT") {
      const auth = await authenticate(request);
      if (!auth) {
        return new Response(
          JSON.stringify({ error: "인증이 필요합니다." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        console.log("🔐 비밀번호 변경 요청:", auth.userId);
        const data = await request.json();
        
        if (!data.current_password || !data.new_password) {
          return new Response(
            JSON.stringify({ error: "현재 비밀번호와 새 비밀번호를 모두 입력해주세요." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        if (data.new_password.length < 6) {
          return new Response(
            JSON.stringify({ error: "새 비밀번호는 6자 이상이어야 합니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 현재 비밀번호 확인
        const user = await db.prepare(
          "SELECT password_hash FROM users WHERE id = ?"
        ).bind(auth.userId).first();
        
        const isCurrentPasswordValid = await verifyPassword(data.current_password, user.password_hash);
        if (!isCurrentPasswordValid) {
          console.log("❌ 현재 비밀번호 불일치");
          return new Response(
            JSON.stringify({ error: "현재 비밀번호가 일치하지 않습니다." }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 새 비밀번호 해싱 및 저장
        const newPasswordHash = await hashPassword(data.new_password);
        await db.prepare(
          "UPDATE users SET password_hash = ? WHERE id = ?"
        ).bind(newPasswordHash, auth.userId).run();
        
        // 모든 세션 무효화 (보안상의 이유로)
        await invalidateAllSessions(auth.userId, kvSessions);
        
        console.log("✅ 비밀번호 변경 성공");
        return new Response(
          JSON.stringify({
            success: true,
            message: "비밀번호가 성공적으로 변경되었습니다. 다시 로그인해주세요.",
            note: "모든 세션이 무효화되었습니다."
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (error) {
        console.error("💥 비밀번호 변경 오류:", error);
        return new Response(
          JSON.stringify({ error: "비밀번호 변경 중 오류가 발생했습니다." }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 7. 로그아웃 API
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        await kvSessions.delete(token);
        console.log("👋 로그아웃: 세션 삭제됨");
      }
      
      return new Response(
        JSON.stringify({
          success: true,
          message: "로그아웃되었습니다."
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // 8. 이메일 인증 API
    if (url.pathname === "/api/auth/verify" && request.method === "GET") {
      try {
        const token = url.searchParams.get("token");
        
        if (!token) {
          return new Response(
            JSON.stringify({ error: "인증 토큰이 필요합니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        // 토큰 검증 및 사용자 업데이트
        const verifiedAt = new Date().toISOString();
        const result = await db.prepare(
          "UPDATE users SET email_verified = 1, verified_at = ?, verification_code = NULL WHERE verification_code = ?"
        ).bind(verifiedAt, token).run();
        
        if (result.changes === 0) {
          console.log("❌ 유효하지 않은 인증 토큰");
          return new Response(
            JSON.stringify({ error: "유효하지 않은 인증 토큰입니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        console.log("✅ 이메일 인증 성공");
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: "이메일 인증이 완료되었습니다." 
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (error) {
        console.error("💥 이메일 인증 오류:", error);
        return new Response(
          JSON.stringify({ error: "인증 처리 중 오류가 발생했습니다." }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 9. 내 정보 요약 API (간단한 정보)
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const auth = await authenticate(request);
      if (!auth) {
        return new Response(
          JSON.stringify({ error: "인증이 필요합니다." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      await updateSessionLastActive(auth.token, kvSessions);
      
      return new Response(
        JSON.stringify({
          success: true,
          user: {
            id: auth.userData.id,
            email: auth.userData.email,
            nickname: auth.userData.nickname,
            balance: auth.userData.balance
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // ==================== 음원 관련 API (기본 구조) ====================
    
    // 10. 음원 목록 API
    if (url.pathname === "/api/music/list" && request.method === "GET") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const offset = parseInt(url.searchParams.get("offset") || "0");
        
        const { results } = await db.prepare(
          `SELECT m.*, u.nickname as artist_name 
           FROM music m 
           LEFT JOIN users u ON m.artist_id = u.id 
           WHERE m.status = 'active'
           ORDER BY m.created_at DESC 
           LIMIT ? OFFSET ?`
        ).bind(limit, offset).all();
        
        return new Response(
          JSON.stringify({
            success: true,
            count: results.length,
            music: results
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (error) {
        console.error("음원 목록 오류:", error);
        return new Response(
          JSON.stringify({
            success: false,
            message: "음원 목록 조회 중 오류가 발생했습니다."
          }),
          { status: 500, headers: corsHeaders }
        );
      }
    }
    
    // 404 처리
    return new Response(
      JSON.stringify({
        success: false,
        message: "요청하신 API를 찾을 수 없습니다.",
        path: url.pathname,
        method: request.method,
        available_endpoints: [
          "GET /",
          "POST /api/auth/signup",
          "POST /api/auth/login",
          "GET /api/auth/profile",
          "PUT /api/auth/profile",
          "PUT /api/auth/change-password",
          "POST /api/auth/logout",
          "GET /api/auth/verify?token={token}",
          "GET /api/music/list"
        ]
      }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
}

// ==================== 헬퍼 함수들 ====================

// 비밀번호 해싱 함수
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 비밀번호 검증 함수
async function verifyPassword(password, hashedPassword) {
  const newHash = await hashPassword(password);
  return newHash === hashedPassword;
}

// 인증 코드 생성 함수
function generateVerificationCode() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// 세션 토큰 생성 함수
function generateSessionToken() {
  return 'session_' + Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// 이메일 발송 함수
async function sendVerificationEmail(email, verificationCode, env) {
  if (!env.SENDGRID_API_KEY || env.SENDGRID_API_KEY.includes('...')) {
    console.log("⚠️ SendGrid API 키 미설정, 이메일 건너뜀");
    console.log("🔑 인증 코드:", verificationCode);
    return;
  }
  
  const verificationUrl = `${env.APP_URL}/verify?token=${verificationCode}`;
  
  const emailData = {
    personalizations: [{
      to: [{ email: email }],
      subject: 'TimeLink 이메일 인증'
    }],
    from: {
      email: env.EMAIL_FROM || 'noreply@timelink.digital',
      name: 'TimeLink'
    },
    content: [{
      type: 'text/html',
      value: `
        <h2>TimeLink 이메일 인증</h2>
        <p>아래 링크를 클릭하여 이메일 인증을 완료해주세요:</p>
        <p><a href="${verificationUrl}">이메일 인증하기</a></p>
        <p>인증 코드: <strong>${verificationCode}</strong></p>
      `
    }]
  };
  
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailData)
  });
  
  if (!response.ok) {
    throw new Error(`SendGrid 오류: ${response.status}`);
  }
}

// 세션 마지막 활동 시간 업데이트
async function updateSessionLastActive(token, kvSessions) {
  try {
    const sessionData = await kvSessions.get(token);
    if (sessionData) {
      const session = JSON.parse(sessionData);
      session.lastActive = new Date().toISOString();
      await kvSessions.put(token, JSON.stringify(session), {
        expirationTtl: 60 * 60 * 24 * 7
      });
    }
  } catch (error) {
    console.error("세션 업데이트 오류:", error);
  }
}

// 모든 세션 무효화
async function invalidateAllSessions(userId, kvSessions) {
  // 실제 구현에서는 사용자 ID에 연결된 모든 세션을 찾아 삭제
  console.log(`🔒 사용자 ${userId}의 모든 세션 무효화`);
  // 현재는 단순화된 구현
  // 실제로는 세션에 userId를 저장하고, 해당 userId를 가진 모든 세션 삭제
}

// 가입일 조회
async function getUserJoinedDate(userId, db) {
  try {
    const result = await db.prepare(
      "SELECT created_at FROM users WHERE id = ?"
    ).bind(userId).first();
    return result ? result.created_at : null;
  } catch (error) {
    console.error("가입일 조회 오류:", error);
    return null;
  }
}

// 사용자 통계 조회
async function getUserStats(userId, db) {
  try {
    // 간단한 통계 (실제로는 여러 테이블에서 조회)
    const [musicCount, salesCount] = await Promise.all([
      db.prepare("SELECT COUNT(*) as count FROM music WHERE artist_id = ?").bind(userId).first(),
      db.prepare("SELECT COUNT(*) as count FROM sales WHERE seller_id = ?").bind(userId).first()
    ]);
    
    return {
      music_uploaded: musicCount?.count || 0,
      total_sales: salesCount?.count || 0,
      // 추가 통계 필드
    };
  } catch (error) {
    console.error("사용자 통계 조회 오류:", error);
    return {
      music_uploaded: 0,
      total_sales: 0
    };
  }
}
