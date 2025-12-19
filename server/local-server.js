// server/local-server.js 생성
cat > server/local-server.js << 'EOF'
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 프론트엔드 파일 서빙
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// API 엔드포인트들 (Cloudflare Worker로 프록시하거나 임시 구현)
app.post('/api/auth/login', (req, res) => {
    console.log('로그인 요청:', req.body);
    res.json({
        success: true,
        token: 'test-jwt-token-' + Date.now(),
        user: {
            id: 1,
            email: req.body.email,
            name: '테스트 사용자'
        }
    });
});

app.post('/api/auth/signup', (req, res) => {
    console.log('회원가입 요청:', req.body);
    res.json({
        success: true,
        message: '회원가입 성공 (테스트)'
    });
});

app.get('/api/music/list', (req, res) => {
    res.json({
        success: true,
        music: [
            {
                id: 1,
                title: "샘플 음원 1",
                artist: "테스트 아티스트",
                price: 10.5,
                duration: "3:45",
                genre: "팝"
            },
            {
                id: 2,
                title: "샘플 음원 2", 
                artist: "테스트 아티스트 2",
                price: 15.0,
                duration: "4:20",
                genre: "재즈"
            }
        ]
    });
});

app.get('/api/marketplace/listings', (req, res) => {
    res.json({
        success: true,
        listings: [
            {
                id: 1,
                title: "인기 음원",
                seller: "판매자A",
                price: 20.0,
                rating: 4.8
            }
        ]
    });
});

// 모든 라우트를 index.html로 (SPA 지원)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 로컬 개발 서버 실행 중: http://localhost:${PORT}`);
    console.log(`📁 정적 파일: ${path.join(__dirname, '..', 'public')}`);
});
EOF
