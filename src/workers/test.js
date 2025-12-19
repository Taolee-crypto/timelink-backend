export default {
  async fetch(request) {
    return new Response(JSON.stringify({
      status: "success",
      message: "TimeLink API 배포 성공!",
      timestamp: new Date().toISOString()
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
