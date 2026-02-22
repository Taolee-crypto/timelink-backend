// src/index.ts - 완전한 CORS + 핵심 엔드포인트

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", "application/json");

    if (path === "/") {
      return new Response(JSON.stringify({ message: "Pulse API Ready" }), { headers });
    }

    if (path === "/pulse") {
      return new Response(JSON.stringify({ live: 2847 }), { headers });
    }

    if (path === "/tracks") {
      return new Response(JSON.stringify([]), { headers });
    }

    if (path === "/create" && request.method === "POST") {
      return new Response(JSON.stringify({ success: true }), { status: 201, headers });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
  }
};
