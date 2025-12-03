import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import { v4 as uuidv4 } from 'uuid';

addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. /api/uuid 처리
  if (url.pathname === '/api/uuid') {
    const uuid = uuidv4();
    event.respondWith(
      new Response(JSON.stringify({ uuid }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*', // CORS 허용
        },
      })
    );
    return;
  }

  // 2. 나머지는 정적 자산 서빙
  event.respondWith(
    getAssetFromKV(event, {
      cacheControl: { bypassCache: true } // 개발용 캐시 무시
    }).catch(() => new Response('Not Found', { status: 404 }))
  );
});
