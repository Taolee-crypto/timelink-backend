import { Router } from 'itty-router';
import { TL3Converter } from '../lib/tl3-converter.js';

const router = Router();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

router.options('*', () => new Response(null, { headers: corsHeaders }));

// Health check endpoint
router.get('/api/health', () => {
  return new Response(JSON.stringify({
    status: 'ok',
    service: 'TimeLink Backend API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    domain: 'api.timelink.digital',
    features: ['tl3-conversion', 'time-license', 'encryption']
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// Audio conversion endpoint
router.post('/api/convert', async (request) => {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');
    const metadata = JSON.parse(formData.get('metadata') || '{}');
    
    const converter = new TL3Converter();
    const result = await converter.convert(audioFile, metadata);
    
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// 간단한 인증을 위한 엔드포인트 추가
router.post('/api/auth/login', async (request, env) => {
  try {
    const data = await request.json();
    
    if (!data.email || !data.password) {
      return new Response(JSON.stringify({
        success: false,
        error: '이메일과 비밀번호를 입력해주세요'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // 간단한 하드코딩된 인증 (실제로는 데이터베이스 조회 필요)
    const validUsers = {
      'test@timelink.com': {
        password: 'test123', // 실제로는 해시값으로 저장
        nickname: '테스트유저',
        tlBalance: 10000
      }
    };
    
    const user = validUsers[data.email];
    
    if (!user || user.password !== data.password) {
      return new Response(JSON.stringify({
        success: false,
        error: '이메일 또는 비밀번호가 일치하지 않습니다'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // 간단한 토큰 생성
    const tokenData = {
      email: data.email,
      nickname: user.nickname,
      exp: Date.now() + 24 * 60 * 60 * 1000 // 24시간
    };
    
    return new Response(JSON.stringify({
      success: true,
      token: btoa(JSON.stringify(tokenData)),
      user: {
        email: data.email,
        nickname: user.nickname,
        tlBalance: user.tlBalance
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: '로그인 처리 중 오류 발생'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// 음악 스트리밍 시뮬레이션 엔드포인트
router.post('/api/music/stream', async (request) => {
  try {
    const data = await request.json();
    
    if (!data.albumId || !data.duration) {
      return new Response(JSON.stringify({
        success: false,
        error: '앨범 ID와 재생 시간이 필요합니다'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // TL 소비 계산 (시뮬레이션)
    const tlPerMinute = 5; // 분당 5 TL
    const tlConsumed = Math.ceil(data.duration / 60) * tlPerMinute;
    
    return new Response(JSON.stringify({
      success: true,
      streamId: `stream_${Date.now()}`,
      albumId: data.albumId,
      duration: data.duration,
      tlConsumed: tlConsumed,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: '스트리밍 처리 중 오류 발생'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// TL 잔액 조회 (시뮬레이션)
router.get('/api/user/balance', async (request) => {
  try {
    // 인증 헤더 확인 (간단한 예제)
    const authHeader = request.headers.get('Authorization');
    
    return new Response(JSON.stringify({
      success: true,
      balance: 10000, // 기본값
      currency: 'TL',
      lastUpdated: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: '잔액 조회 중 오류 발생'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// 404 핸들러
router.all('*', () => {
  return new Response(JSON.stringify({
    error: 'API endpoint not found'
  }), {
    status: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

export default {
  fetch: router.handle
};
