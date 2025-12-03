import { v4 as uuidv4 } from 'uuid';

addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

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
  } else {
    // 정적 자산 서빙
    event.respondWith(
      getAssetFromKV(event) // Wrangler의 asset-serving 함수
    );
  }
});
