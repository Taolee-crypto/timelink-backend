const express = require("express");
const sgMail = require("@sendgrid/mail");
const fs = require("fs");

// 1. .env 파일에서 SendGrid API 키 읽기
let SENDGRID_API_KEY = "";
if (fs.existsSync(".env")) {
    const content = fs.readFileSync(".env", "utf8");
    const match = content.match(/SENDGRID_API_KEY=(.+)/);
    if (match) SENDGRID_API_KEY = match[1].trim();
}

console.log("🔑 SendGrid API 키 상태:", SENDGRID_API_KEY ? "✅ 설정됨" : "❌ 없음");

const app = express();
app.use(express.json());

// 2. CORS 설정 (timelink.digital만 허용)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "https://timelink.digital");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();
    next();
});

// 3. SendGrid 설정
if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
}

// 4. 이메일 발송 API (프론트엔드와 일치하는 경로)
app.post("/auth/send-verification", async (req, res) => {
    const email = req.body?.email;
    
    if (!email) {
        return res.status(400).json({ success: false, error: "이메일 주소가 필요합니다" });
    }
    
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    console.log("📧 이메일 발송 시도:", email, "코드:", verificationCode);
    
    // SendGrid API 키가 있고 실제 키 형식인 경우
    if (SENDGRID_API_KEY && SENDGRID_API_KEY.startsWith("SG.")) {
        try {
            const msg = {
                to: email,
                from: "noreply@timelink.digital",
                subject: "TimeLink 이메일 인증 코드",
                text: `인증 코드: ${verificationCode}`,
                html: `<h3>TimeLink 인증 코드</h3><p><strong>${verificationCode}</strong></p>`
            };
            
            console.log("📤 SendGrid로 이메일 발송 중...");
            await sgMail.send(msg);
            console.log("✅ 이메일 발송 성공!");
            
            return res.json({
                success: true,
                message: "이메일이 발송되었습니다",
                code: verificationCode
            });
            
        } catch (error) {
            console.error("❌ SendGrid 오류:", error.message);
            return res.status(500).json({
                success: false,
                error: error.message,
                code: verificationCode
            });
        }
    } else {
        // 개발 모드 (SendGrid API 키 없음)
        console.log("🛠️ 개발 모드 - 실제 이메일 없음");
        return res.json({
            success: true,
            code: verificationCode,
            devMode: true,
            message: "개발 모드: SendGrid API 키 필요"
        });
    }
});

// 5. 서버 실행
const PORT = 3001;
app.listen(PORT, () => {
    console.log("\n" + "=".repeat(60));
    console.log("🚀 TimeLink 이메일 서버 시작 완료!");
    console.log(`📍 서버 주소: http://localhost:${PORT}`);
    console.log("📧 API 엔드포인트: POST /auth/send-verification");
    console.log("🌐 CORS 허용: https://timelink.digital");
    console.log("🔑 SendGrid: " + (SENDGRID_API_KEY ? "✅ 설정됨" : "❌ 설정안됨"));
    console.log("=".repeat(60) + "\n");
});
