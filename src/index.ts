// src/index.ts - CORS 완전 지원 버전

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",  // 테스트용 전체 허용 (운영 시 "https://timelink.digital"로 변경)
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",  // preflight 캐시 1일
};

export default {
  async fetch(request: Request): Promise<Response> {
    // 1. OPTIONS preflight 요청 처리 (브라우저가 CORS 확인용으로 자동 보냄)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // 2. 실제 요청 처리
    const url = new URL(request.url);
    const path = url.pathname;

    // 모든 응답에 CORS 헤더 강제 추가
    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", "application/json");

    if (path === "/" || path === "") {
      return new Response(
        JSON.stringify({ message: "Pulse Worker Ready! Use /tracks, /create, /boost/:id" }),
        { status: 200, headers }
      );
    }

    if (path === "/tracks") {
      // 임시 빈 트랙 리스트 (나중에 실제 데이터로 교체)
      return new Response(
        JSON.stringify([]),
        { status: 200, headers }
      );
    }

    if (path === "/pulse") {
      return new Response(
        JSON.stringify({ live: 2847 }),
        { status: 200, headers }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not Found" }),
      { status: 404, headers }
    );
  },
};
