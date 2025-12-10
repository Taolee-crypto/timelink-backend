import { Router } from 'itty-router';

const router = Router();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

router.options('*', () => new Response(null, { headers: corsHeaders }));

router.get('/api/health', () => {
  return new Response(JSON.stringify({
    status: 'ok',
    service: 'TimeLink Backend API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    domain: 'api.timelink.digital'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

router.post('/api/convert', async (request) => {
  return new Response(JSON.stringify({
    success: true,
    contentId: `tl3_${Date.now()}`,
    message: 'TL3 변환 API 준비됨'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

export default {
  fetch: router.handle
};
