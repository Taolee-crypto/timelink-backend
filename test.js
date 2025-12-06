export default {
  async fetch(request) {
    return new Response(JSON.stringify({
      message: "TL Platform",
      status: "online",
      account: "a056839cbee168dca5a9439167f98143"
    }), {
      headers: { 
        'content-type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });
  }
}
