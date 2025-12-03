export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/uuid") {
      const uuid = crypto.randomUUID();
      return new Response(JSON.stringify({ uuid }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 나머지 경로는 정적 자산 제공
    return await getAssetFromKV(request);
  }
};
