/**
 * send-email.js
 *  - SendGrid 단순 전송 함수
 *  - env (wrangler vars)에서 API 키와 발신자 주소를 전달받아 사용
 *
 * 반환값: { ok: boolean, status?: number, text?: string }
 */

export async function sendVerificationEmail(apiKey, fromEmail, toEmail, code) {
  if (!apiKey) throw new Error("SENDGRID_API_KEY is required");
  if (!fromEmail) throw new Error("EMAIL_FROM is required");

  const body = {
    personalizations: [
      {
        to: [{ email: toEmail }],
        subject: "TimeLink 인증 코드 (5분 유효)"
      }
    ],
    from: { email: fromEmail },
    content: [
      {
        type: "text/plain",
        value:
          `TimeLink 인증 코드입니다.\n\n` +
          `코드: ${code}\n\n` +
          `이 코드는 발송 시점부터 5분 동안만 유효합니다.\n\n` +
          `만약 요청하지 않았다면 무시하세요.\n\n` +
          `— TimeLink Team`
      },
      {
        type: "text/html",
        value:
          `<div style="font-family:Arial,sans-serif;line-height:1.4">` +
          `<h2>TimeLink 인증 코드</h2>` +
          `<p>인증 코드: <strong style="font-size:20px">${code}</strong></p>` +
          `<p>이 코드는 <strong>5분</strong> 동안만 유효합니다.</p>` +
          `<hr/><p style="font-size:12px;color:#666">요청하지 않았다면 이 메일을 무시하세요.</p>` +
          `</div>`
      }
    ]
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
}
