import express from "express";
import cors from "cors";

const app = express();
const PORT = 8787;

// CORS 설정
app.use(cors({
    origin: ["http://localhost:6199", "http://localhost:3003", "http://localhost:5000"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

app.use(express.json());

// 로깅 미들웨어
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// OPTIONS 요청 처리
app.options("*", cors());

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        service: "TimeLink Backend",
        version: "1.0.0",
        port: PORT,
        timestamp: new Date().toISOString(),
        endpoints: [
            "GET    /health",
            "POST   /api/auth/signup",
            "POST   /api/auth/verify-email",
            "POST   /api/auth/login",
            "GET    /api/test",
            "GET    /api/todos"
        ]
    });
});

// 테스트 API
app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "TimeLink 백엔드 API 작동중",
        environment: "development",
        timestamp: new Date().toISOString()
    });
});

// 회원가입 API
app.post("/api/auth/signup", (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        console.log("📧 회원가입 요청:", { name, email });
        
        // 필수 입력 확인
        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "이름, 이메일, 비밀번호를 모두 입력해주세요."
            });
        }
        
        // 이메일 형식 확인
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "유효한 이메일 주소를 입력해주세요."
            });
        }
        
        // 비밀번호 길이 확인
        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "비밀번호는 8자 이상이어야 합니다."
            });
        }
        
        // 인증 코드 생성 (실제로는 이메일로 전송)
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        console.log(`🔐 개발 모드 - ${email}님의 인증 코드: ${verificationCode}`);
        
        res.json({
            success: true,
            message: "회원가입이 완료되었습니다. 이메일 인증을 진행해주세요.",
            email: email,
            verificationRequired: true,
            verificationCode: verificationCode, // 개발 모드에서만 노출
            note: "개발 모드: 실제 서비스에서는 이메일로 전송됩니다."
        });
        
    } catch (error) {
        console.error("회원가입 에러:", error);
        res.status(500).json({
            success: false,
            message: "서버 오류가 발생했습니다."
        });
    }
});

// 이메일 인증 확인 API
app.post("/api/auth/verify-email", (req, res) => {
    try {
        const { email, code } = req.body;
        
        console.log("✅ 이메일 인증 요청:", { email, code });
        
        if (!email || !code) {
            return res.status(400).json({
                success: false,
                message: "이메일과 인증 코드를 입력해주세요."
            });
        }
        
        // 인증 코드 검증 (실제로는 DB에서 확인)
        if (code && code.length === 6 && /^\d{6}$/.test(code)) {
            // JWT 토큰 생성 (간단한 버전)
            const token = `jwt-token-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            res.json({
                success: true,
                message: "이메일 인증이 완료되었습니다!",
                token: token,
                user: {
                    id: Date.now(),
                    name: "인증된사용자",
                    email: email,
                    balance: 10000,
                    verified: true,
                    joined: new Date().toISOString()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: "인증 코드가 올바르지 않습니다. 6자리 숫자를 입력해주세요."
            });
        }
        
    } catch (error) {
        console.error("이메일 인증 에러:", error);
        res.status(500).json({
            success: false,
            message: "서버 오류가 발생했습니다."
        });
    }
});

// 로그인 API
app.post("/api/auth/login", (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log("🔑 로그인 요청:", { email });
        
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "이메일과 비밀번호를 입력해주세요."
            });
        }
        
        // 테스트용 계정
        if (email === "test@test.com" && password === "test1234") {
            const token = `jwt-token-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            res.json({
                success: true,
                message: "로그인 성공",
                token: token,
                user: {
                    id: 1,
                    name: "테스트사용자",
                    email: email,
                    balance: 10000,
                    verified: true,
                    joined: new Date().toISOString()
                }
            });
        } else {
            res.status(401).json({
                success: false,
                message: "이메일 또는 비밀번호가 올바르지 않습니다."
            });
        }
        
    } catch (error) {
        console.error("로그인 에러:", error);
        res.status(500).json({
            success: false,
            message: "서버 오류가 발생했습니다."
        });
    }
});

// ToDo API (예시)
app.get("/api/todos", (req, res) => {
    res.json([
        {
            id: 1,
            title: "TimeLink 회원가입 기능 구현",
            completed: true,
            createdAt: "2024-01-01T10:00:00.000Z"
        },
        {
            id: 2,
            title: "이메일 인증 기능 추가",
            completed: true,
            createdAt: "2024-01-02T14:30:00.000Z"
        },
        {
            id: 3,
            title: "프론트엔드와 API 연동 테스트",
            completed: false,
            createdAt: "2024-01-03T09:15:00.000Z"
        }
    ]);
});

// 사용자 프로필 API
app.get("/api/user/profile", (req, res) => {
    const token = req.headers.authorization;
    
    if (!token) {
        return res.status(401).json({
            success: false,
            message: "인증 토큰이 필요합니다."
        });
    }
    
    res.json({
        success: true,
        user: {
            id: 1,
            name: "테스트사용자",
            email: "test@test.com",
            balance: 10000,
            verified: true,
            joined: "2024-01-01T00:00:00.000Z"
        }
    });
});

// 404 처리
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "요청한 API를 찾을 수 없습니다.",
        path: req.url,
        method: req.method
    });
});

// 에러 처리
app.use((err, req, res, next) => {
    console.error("서버 에러:", err);
    res.status(500).json({
        success: false,
        message: "서버 내부 오류가 발생했습니다.",
        error: process.env.NODE_ENV === "development" ? err.message : undefined
    });
});

// 서버 시작
app.listen(PORT, () => {
    console.log("");
    console.log("🚀 TimeLink 백엔드 서버 시작!");
    console.log("📡 URL: http://localhost:" + PORT);
    console.log("🏥 Health Check: http://localhost:" + PORT + "/health");
    console.log("🔧 API 테스트: http://localhost:" + PORT + "/api/test");
    console.log("");
    console.log("📋 테스트 계정:");
    console.log("   📧 이메일: test@test.com");
    console.log("   🔑 비밀번호: test1234");
    console.log("");
    console.log("🔄 프록시 서버 (3003)와 연결 확인:");
    console.log("   http://localhost:3003/health");
    console.log("");
});
