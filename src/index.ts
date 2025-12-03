import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import { v4 as uuidv4 } from 'uuid';

async function handleUUID(request: Request): Promise<Response> {
  const id = uuidv4();
  return new Response(JSON.stringify({ uuid: id }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === "/api/uuid") {
    event.respondWith(handleUUID(event.request));
    return; // 여기서 끝
  }

  // 나머지는 정적 자산
  event.respondWith(
    getAssetFromKV(event, {
      cacheControl: { bypassCache: true } // 개발용 캐시 무시
    }).catch(() => new Response('Not Found', { status: 404 }))
  );
});
