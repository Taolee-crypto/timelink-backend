// auth.js - 최대 디버그 모드
export default {
  async fetch(request, env, ctx) {
    console.log("🚨 ENTERING FETCH FUNCTION");
    
    const url = new URL(request.url);
    console.log("📡 URL:", url.toString());
    console.log("📡 Pathname:", url.pathname);
    console.log("📡 Method:", request.method);
    
    // 모든 요청에 대해 기본 응답
    if (url.pathname === "/api/auth/signup" && request.method === "POST") {
      console.log("🎯 SIGNUP ENDPOINT HIT");
      
      try {
        // 1. Raw body 확인
        const rawBody = await request.text();
        console.log("📦 RAW BODY LENGTH:", rawBody.length);
        console.log("📦 RAW BODY CONTENT:", rawBody);
        
        // 2. JSON 파싱 시도
        console.log("🔄 ATTEMPTING JSON PARSE...");
        let data;
        try {
          data = JSON.parse(rawBody);
          console.log("✅ JSON PARSE SUCCESS");
          console.log("📊 PARSED DATA:", JSON.stringify(data, null, 2));
        } catch (parseError) {
          console.log("❌ JSON PARSE FAILED:", parseError.message);
          return new Response(
            JSON.stringify({ 
              error: "JSON 파싱 실패", 
              debug: { raw_body_preview: rawBody.substring(0, 100) }
            }),
            { 
              status: 400, 
              headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            }
          );
        }
        
        // 3. 모든 필드 상세 확인
        console.log("🔍 DETAILED FIELD ANALYSIS:");
        console.log("  - email exists:", "email" in data, "value:", data.email);
        console.log("  - password exists:", "password" in data, "length:", data.password ? data.password.length : 0);
        console.log("  - name exists:", "name" in data, "value:", data.name);
        console.log("  - All keys:", Object.keys(data));
        
        // 4. 단순 검증: 필드 존재만 확인
        const missing = [];
        if (!data.email || data.email.trim() === "") {
          console.log("⚠️ email missing or empty");
          missing.push("email");
        }
        if (!data.password || data.password.trim() === "") {
          console.log("⚠️ password missing or empty");
          missing.push("password");
        }
        if (!data.name || data.name.trim() === "") {
          console.log("⚠️ name missing or empty");
          missing.push("name");
        }
        
        if (missing.length > 0) {
          console.log("❌ MISSING FIELDS:", missing);
          return new Response(
            JSON.stringify({ 
              error: "필수 항목이 누락되었습니다",
              missing: missing,
              debug: {
                received_keys: Object.keys(data),
                email_value: data.email,
                password_length: data.password ? data.password.length : 0,
                name_value: data.name
              }
            }),
            { 
              status: 400, 
              headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            }
          );
        }
        
        // 5. 성공 응답
        console.log("🎉 ALL CHECKS PASSED!");
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: "회원가입 검증 성공!",
            data: {
              email: data.email,
              name: data.name,
              validation: "passed"
            }
          }),
          { 
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
        
      } catch (error) {
        console.error("💥 UNEXPECTED ERROR:", error);
        return new Response(
          JSON.stringify({ error: "서버 오류", details: error.message }),
          { 
            status: 500, 
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }
    }
    
    // 기본 응답
    console.log("🏁 RETURNING DEFAULT RESPONSE");
    return new Response(
      JSON.stringify({
        service: "TimeLink API",
        status: "debug_mode",
        time: new Date().toISOString()
      }),
      { 
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
}
