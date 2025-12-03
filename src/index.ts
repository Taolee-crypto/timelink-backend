export default {
  async fetch(request: Request) {
    return new Response(JSON.stringify({ uuid: crypto.randomUUID() }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};
