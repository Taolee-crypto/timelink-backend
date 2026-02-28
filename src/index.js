
// ===== 기여도 시스템 API =====
async function handleActivity(request, env) {
  try {
    const { user_id, type, metadata } = await request.json();
    
    const pointMap = {
      listen_minute: 1,
      upload: 100,
      like: 2,
      comment: 5,
      share: 3,
      ad_view: 10,
      report: -20,
      violation: -100
    };
    
    let points = pointMap[type] || 0;
    if (type === 'listen_minute' && metadata?.minutes) {
      points = metadata.minutes * pointMap.listen_minute;
    }
    
    // 활동 저장
    await env.DB.prepare(
      `INSERT INTO user_activities (user_id, activity_type, points, metadata)
       VALUES (?, ?, ?, ?)`
    ).bind(user_id, type, points, JSON.stringify(metadata)).run();
    
    // user_poc 업데이트
    await env.DB.prepare(
      `INSERT INTO user_poc (user_id, total_points, last_updated)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         total_points = total_points + excluded.total_points,
         last_updated = CURRENT_TIMESTAMP`
    ).bind(user_id, points).run();
    
    // daily_stats 업데이트 (양수만)
    if (points > 0) {
      const today = new Date().toISOString().slice(0,10);
      await env.DB.prepare(
        `INSERT INTO daily_stats (stat_date, user_id, points_earned)
         VALUES (?, ?, ?)
         ON CONFLICT(stat_date, user_id) DO UPDATE SET
           points_earned = points_earned + excluded.points_earned`
      ).bind(today, user_id, points).run();
    }
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

async function handleUserStats(request, env) {
  const url = new URL(request.url);
  const user_id = url.searchParams.get('user_id');
  const period = url.searchParams.get('period') || 'week';
  
  if (!user_id) return new Response('Missing user_id', { status: 400 });
  
  let startDate = new Date();
  if (period === 'day') startDate.setDate(startDate.getDate() - 1);
  else if (period === 'week') startDate.setDate(startDate.getDate() - 7);
  else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
  
  const start = startDate.toISOString().slice(0,10);
  
  const stats = await env.DB.prepare(
    `SELECT 
        SUM(points_earned) as total_points,
        SUM(tlc_mined) as total_tlc,
        SUM(tl_used) as total_tl_used
     FROM daily_stats
     WHERE user_id = ? AND stat_date >= ?`
  ).bind(user_id, start).first();
  
  const poc = await env.DB.prepare(
    'SELECT total_points FROM user_poc WHERE user_id = ?'
  ).bind(user_id).first();
  
  return new Response(JSON.stringify({
    period,
    stats: stats || { total_points:0, total_tlc:0, total_tl_used:0 },
    total_points: poc?.total_points || 0
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleRanking(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'tlc';
  const period = url.searchParams.get('period') || 'week';
  const limit = parseInt(url.searchParams.get('limit') || '10');
  
  let startDate = new Date();
  if (period === 'day') startDate.setDate(startDate.getDate() - 1);
  else if (period === 'week') startDate.setDate(startDate.getDate() - 7);
  else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
  
  const start = startDate.toISOString().slice(0,10);
  
  let orderBy, selectExpr;
  if (type === 'tlc') {
    selectExpr = 'SUM(tlc_mined) as value';
    orderBy = 'value DESC';
  } else if (type === 'points') {
    selectExpr = 'SUM(points_earned) as value';
    orderBy = 'value DESC';
  } else {
    return new Response('Invalid type', { status: 400 });
  }
  
  const rows = await env.DB.prepare(
    `SELECT user_id, ${selectExpr}
     FROM daily_stats
     WHERE stat_date >= ?
     GROUP BY user_id
     ORDER BY ${orderBy}
     LIMIT ?`
  ).bind(start, limit).all();
  
  return new Response(JSON.stringify(rows.results), {
    headers: { 'Content-Type': 'application/json' }
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ==================== 사용자 API ====================
    
    // 로그인
    if (url.pathname === '/api/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json();
        
        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE email = ?'
        ).bind(email).first();

        if (!user) {
          return new Response(JSON.stringify({ success: false, error: 'User not found' }), { 
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (user.password_hash !== password) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid password' }), { 
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const { password_hash, ...userWithoutPassword } = user;
        
        return new Response(JSON.stringify({
          success: true,
          user: userWithoutPassword,
          token: 'token_' + Date.now()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // 회원가입
    if (url.pathname === '/api/register' && request.method === 'POST') {
      try {
        const { username, email, password, role, isBusiness, businessName } = await request.json();
        
        // 이메일 중복 확인
        const existing = await env.DB.prepare(
          'SELECT id FROM users WHERE email = ?'
        ).bind(email).first();
        
        if (existing) {
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'Email already exists' 
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const tl = isBusiness ? 20000 : (role === 'creator' ? 15000 : 10000);
        
        const result = await env.DB.prepare(
          'INSERT INTO users (username, email, password_hash, tl, role, is_business, business_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          username, 
          email, 
          password, 
          tl, 
          role || 'listener',
          isBusiness ? 1 : 0,
          businessName || null
        ).run();

        return new Response(JSON.stringify({
          success: true,
          userId: result.meta.last_row_id,
          message: '회원가입 성공',
          tl: tl
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ==================== 트랙 API ====================
    
    // 트랙 목록 조회
    if (url.pathname === '/api/tracks' && request.method === 'GET') {
      try {
        const userId = url.searchParams.get('userId');
        let query = 'SELECT * FROM tl_files';
        let params = [];
        
        if (userId) {
          query += ' WHERE user_id = ?';
          params.push(userId);
        }
        
        query += ' ORDER BY created_at DESC';
        
        const tracks = await env.DB.prepare(query).bind(...params).all();
        
        return new Response(JSON.stringify({ tracks: tracks.results }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // 트랙 생성
    if (url.pathname === '/api/tracks' && request.method === 'POST') {
      try {
        const { user_id, title, artist, genre, type, file_tl, url: trackUrl } = await request.json();
        
        const result = await env.DB.prepare(
          'INSERT INTO tl_files (user_id, title, artist, genre, file_type, file_tl, max_file_tl, file_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(user_id, title, artist, genre, type, file_tl, file_tl, trackUrl).run();

        return new Response(JSON.stringify({
          success: true,
          trackId: result.meta.last_row_id
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // 트랙 TL 충전
    if (url.pathname.match(/^\/api\/tracks\/\d+\/charge$/) && request.method === 'POST') {
      try {
        const trackId = url.pathname.split('/')[3];
        const { amount } = await request.json();
        
        await env.DB.prepare(
          'UPDATE tracks SET file_tl = file_tl + ?, max_file_tl = max_file_tl + ? WHERE id = ?'
        ).bind(amount, amount, trackId).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ==================== 지갑 API ====================
    
    // 지갑 정보
    if (url.pathname === '/api/wallet' && request.method === 'GET') {
      try {
        const userId = url.searchParams.get('userId');
        
        const user = await env.DB.prepare(
          'SELECT tl, tlc FROM users WHERE id = ?'
        ).bind(userId).first();

        const exchanges = await env.DB.prepare(
          'SELECT * FROM exchanges WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
        ).bind(userId).all();

        return new Response(JSON.stringify({
          tl: user.tl,
          tlc: user.tlc,
          exchanges: exchanges.results
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // 환전 요청
    if (url.pathname === '/api/exchange' && request.method === 'POST') {
      try {
        const { user_id, amount, payment_method } = await request.json();
        
        // TL 차감
        await env.DB.prepare(
          'UPDATE users SET tl = tl - ? WHERE id = ? AND tl >= ?'
        ).bind(amount, user_id, amount).run();

        // 환전 내역 저장
        const result = await env.DB.prepare(
          'INSERT INTO exchanges (user_id, amount, payment_method) VALUES (?, ?, ?)'
        ).bind(user_id, amount, payment_method).run();

        return new Response(JSON.stringify({
          success: true,
          exchangeId: result.meta.last_row_id
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // TL 충전
    if (url.pathname === '/api/recharge' && request.method === 'POST') {
      try {
        const { user_id, amount } = await request.json();
        
        await env.DB.prepare(
          'UPDATE users SET tl = tl + ? WHERE id = ?'
        ).bind(amount, user_id).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ==================== AI 인증 API ====================
    
    // AI 인증 요청
    if (url.pathname === '/api/ai-verify' && request.method === 'POST') {
      try {
        const { user_id, platform, images } = await request.json();
        
        // 실제로는 이미지 분석 로직 필요
        // 지금은 항상 성공으로 처리
        
        return new Response(JSON.stringify({
          success: true,
          verified: true,
          reward: 1000,
          message: 'AI 인증 완료'
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    return new Response('TimeLink API is running!', { 
      headers: { 'Content-Type': 'text/plain', ...corsHeaders }
    });
  }
};



