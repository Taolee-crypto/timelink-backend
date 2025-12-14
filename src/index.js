export default {
  async fetch(request, env, ctx) {
    return new Response('TimeLink API 서버 준비중...', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
