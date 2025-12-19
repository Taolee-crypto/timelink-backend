/**
 * src/workers/api.js
 * - Cloudflare Worker entry
 * - POST /auth/send-code  => { email }  (send code via SendGrid)
 * - POST /auth/verify-code => { email, code } (verify)
 *
 * 사용: wrangler.toml에 AUTH_CODES(KV), SENDGRID_API_KEY, EMAIL_FROM를 설정해야 함.
 */

import { generateCode, saveCode, verifyCode } from "../lib/auth.js";
import { sendVerificationEmail } from "../lib/send-email.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, ""); // trim trailing slash

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    try {
      if (pathname === "/auth/send-code" && request.method === "POST") {
        return await handleSendCode(request, env);
      }

      if (pathname === "/auth/verify-code" && request.method === "POST") {
        return await handleVerifyCode(request, env);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      // 로그를 콘솔에 남겨 배포 환경에서 inspect 가능
      console.error("Unhandled error:", err);
      return json({ error: "internal_error", message: String(err) }, 500);
    }
  }
};

async function handleSendCode(request, env) {
  const contentType = request.headers.get("content-type") || "";
  let body;
  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    // fallback: try text
    const t = await request.text();
    try {
      body = JSON.parse(t || "{}");
    } catch {
      body = {};
    }
  }

  const email = body.email && String(body.email).trim();
  if (!email) return json({ ok: false, error: "email_required" }, 400);

  // 기본적인 이메일 형식 간단 체크 (엄격 검사는 프론트/별도 로직)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  const code = generateCode();

  // save to KV
  await saveCode(env.AUTH_CODES, email, code);

  // send via SendGrid
  const result = await sendVerificationEmail(env.SENDGRID_API_KEY, env.EMAIL_FROM, email, code);
  if (!result.ok) {
    console.error("SendGrid failed:", result.status, result.text);
    return json({ ok: false, error: "send_failed", detail: result.text }, 502);
  }

  return json({ ok: true });
}

async function handleVerifyCode(request, env) {
  const contentType = request.headers.get("content-type") || "";
  let body;
  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const t = await request.text();
    try { body = JSON.parse(t || "{}"); } catch { body = {}; }
  }

  const email = body.email && String(body.email).trim();
  const code = body.code && String(body.code).trim();

  if (!email || !code) return json({ ok: false, error: "missing_fields" }, 400);

  const result = await verifyCode(env.AUTH_CODES, email, code);

  if (result.ok) {
    // 성공 시, 여기서 JWT/세션 생성 또는 사용자 데이터베이스 업데이트하는 로직을 넣을 수 있음.
    // 예시: JWT 발급 (없다면 프론트에서 이후 액션 처리)
    return json({ ok: true });
  } else {
    return json({ ok: false, error: result.reason || "invalid" }, 400);
  }
}

/* Helpers */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    }
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    }
  });
}
