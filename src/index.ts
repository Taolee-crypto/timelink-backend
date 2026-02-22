// src/index.ts - TimeLink API 기본 Worker (TypeScript)

export interface Env {
  // 필요 시 KV, D1 등 바인딩 추가
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 루트 경로: 기본 메시지 (기존처럼)
    if (path === "/" || path === "") {
      return new Response(
        "Pulse Worker Ready! Use /tracks, /create, /boost/:id",
        { status: 200, headers: { "Content-Type": "text/plain" } }
      );
    }

    // /pulse - 실시간 Pulse 카운트 (임시 더미 데이터)
    if (path === "/pulse") {
      return new Response(
        JSON.stringify({ live: 2847, message: "Pulse count from Worker" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // /tracks - Hot Pulse 트랙 리스트 (임시 빈 배열)
    if (path === "/tracks") {
      return new Response(
        JSON.stringify([]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // /create - 트랙 생성 (임시 성공 응답)
    if (path === "/create" && request.method === "POST") {
      return new Response(
        JSON.stringify({ success: true, id: "new-track-001" }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }

    // 404 Not Found
    return new Response("Not Found", { status: 404 });
  },
};
