export default {
  async fetch(request) {
    return new Response(JSON.stringify({
      status: 'ok',
      service: 'TimeLink API',
      version: '2.0.0',
      timestamp: new Date().toISOString()
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
