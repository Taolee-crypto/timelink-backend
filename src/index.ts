export default {
  async fetch(request: Request) {
    // 임의 UUID 생성
    const uuid = crypto.randomUUID();

    return new Response(
      JSON.stringify({ uuid }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
