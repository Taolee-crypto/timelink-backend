// src/index.ts - TimeLink API (CORS 완벽 지원 + 핵심 엔드포인트)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",  // 테스트용 전체 허용 (운영 시 "https://timelink.digital"로 변경)
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request): Promise<Response> {
    // OPTIONS preflight 처리 (브라우저 CORS 확인용)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 모든 응답에 CORS 헤더 추가
    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", "application/json");

    // 루트 경로
    if (path === "/" || path === "") {
      return new Response(
        JSON.stringify({ message: "Pulse Worker Ready! Use /tracks, /create, /boost/:id" }),
        { status: 200, headers }
      );
    }

    // Pulse Live (임시 더미, 나중 실시간 카운트)
    if (path === "/pulse") {
      return new Response(
        JSON.stringify({ live: 2847 }),
        { status: 200, headers }
      );
    }

    // Hot Pulse 트랙 리스트 (임시 빈 배열)
    if (path === "/tracks") {
      return new Response(
        JSON.stringify([]),
        { status: 200, headers }
      );
    }

    // Create Track (임시 성공 응답)
    if (path === "/create" && request.method === "POST") {
      return new Response(
        JSON.stringify({ success: true, id: "new-track-" + Date.now() }),
        { status: 201, headers }
      );
    }

    // Boost (임시)
    if (path.startsWith("/boost/") && request.method === "POST") {
      const id = path.split("/boost/")[1];
      return new Response(
        JSON.stringify({ success: true, trackId: id, earningsIncreased: 100 }),
        { status: 200, headers }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not Found" }),
      { status: 404, headers }
    );
  },
};
