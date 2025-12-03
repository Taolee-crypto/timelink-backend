import { v4 as uuidv4 } from 'uuid';

export interface Env {
  TL_SESSIONS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/uuid') {
      // 임의 UUID 생성
      const uuid = uuidv4();
      return new Response(JSON.stringify({ uuid }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 그 외 요청은 정적 파일 서빙
    return fetch(request);
  },
};
