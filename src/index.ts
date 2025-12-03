import { getAssetFromKV } from '@cloudflare/kv-asset-handler';

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/uuid') {
      // 임의 UUID 생성
      const uuid = crypto.randomUUID();
      return new Response(JSON.stringify({ uuid }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 정적 파일 처리
    return await getAssetFromKV(request);
  }
};
