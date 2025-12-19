import { Router } from 'itty-router';
import { TL3Converter } from '../lib/tl3-converter.js';

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
    domain: 'api.timelink.digital',
    features: ['tl3-conversion', 'time-license', 'encryption']
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

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
      headers: corsHeaders
    });
  }
});

export default {
  fetch: router.handle
};
