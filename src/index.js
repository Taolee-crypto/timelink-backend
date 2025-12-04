import authAPI from './api/auth.js';
import filesAPI from './api/files.js';
import marketAPI from './api/market.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
    
    // OPTIONS 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // API 라우팅
    if (path.startsWith('/api/auth')) {
      if (path === '/api/auth/login' && request.method === 'POST') {
        return await authAPI.login(request, env);
      }
    }
    
    if (path.startsWith('/api/files')) {
      if (path === '/api/files/upload' && request.method === 'POST') {
        return await filesAPI.upload(request, env);
      }
    }
    
    if (path.startsWith('/api/market')) {
      if (path === '/api/market/items' && request.method === 'GET') {
        return await marketAPI.getItems(request, env);
      }
    }
    
    // 기본 응답
    return new Response('TL Platform API', {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
    });
  }
};
