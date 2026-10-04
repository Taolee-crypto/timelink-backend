import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

// ── POST /api/contact/b2b ──
router.post('/b2b', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => ({}));
    const company = String(body.company || '').trim();
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const type = String(body.type || '').trim();
    const message = String(body.message || '').trim();

    if(!company) return c.json({ ok: false, error: '회사명을 입력해주세요.' }, 400);
    if(!name) return c.json({ ok: false, error: '담당자명을 입력해주세요.' }, 400);
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ ok: false, error: '올바른 이메일을 입력해주세요.' }, 400);
    if(!type) return c.json({ ok: false, error: '문의 유형을 선택해주세요.' }, 400);
    if(!message) return c.json({ ok: false, error: '문의 내용을 입력해주세요.' }, 400);

    const resendKey = (c.env as any).RESEND_API_KEY || '';
    if(!resendKey) return c.json({ ok: false, error: '이메일 서비스가 설정되지 않았습니다.' }, 500);

    const fromEmail = (c.env as any).RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const toEmail = (c.env as any).B2B_TO_EMAIL || 'mununglee@gmail.com';
    const isInvest = type === '투자 자료 요청';

    // ── 1) 사장님 알림 이메일 ──
    const adminHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#f5f5f7;padding:24px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#0071E3,#64D2FF);padding:28px;color:#fff">
      <div style="font-size:11px;letter-spacing:.1em;opacity:.8;margin-bottom:6px">TIMELINK B2B</div>
      <h2 style="margin:0;font-size:22px;font-weight:700">${isInvest ? '📄 투자 자료 요청' : '💼 새로운 문의'}</h2>
    </div>
    <div style="padding:28px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:10px 0;color:#666;width:110px">회사/소속</td><td style="padding:10px 0;font-weight:600">${escHtml(company)}</td></tr>
        <tr><td style="padding:10px 0;color:#666">담당자</td><td style="padding:10px 0;font-weight:600">${escHtml(name)}</td></tr>
        <tr><td style="padding:10px 0;color:#666">이메일</td><td style="padding:10px 0"><a href="mailto:${escHtml(email)}" style="color:#0071E3">${escHtml(email)}</a></td></tr>
        <tr><td style="padding:10px 0;color:#666">전화번호</td><td style="padding:10px 0">${escHtml(phone) || '(미입력)'}</td></tr>
        <tr><td style="padding:10px 0;color:#666">문의유형</td><td style="padding:10px 0"><span style="display:inline-block;padding:4px 12px;background:#e6f2ff;color:#0071E3;border-radius:8px;font-size:12px;font-weight:600">${escHtml(type)}</span></td></tr>
      </table>
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #eee">
        <div style="color:#666;font-size:13px;margin-bottom:10px">문의 내용</div>
        <div style="background:#fafafa;padding:16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap">${escHtml(message)}</div>
      </div>
      ${isInvest ? '<div style="margin-top:20px;padding:14px;background:#e6f2ff;border-radius:10px;font-size:13px;color:#0071E3"><strong>📄 투자 자료 PDF가 요청자에게 자동 발송되었습니다.</strong></div>' : ''}
    </div>
    <div style="padding:16px 28px;background:#fafafa;font-size:11px;color:#999;text-align:center">
      TimeLink · 특허 출원 10-2025-0167813
    </div>
  </div>
</body></html>`;

    const adminText = `[TimeLink B2B] ${isInvest ? '📄 투자 자료 요청' : '💼 새로운 문의'}

회사: ${company}
담당자: ${name}
이메일: ${email}
전화: ${phone || '(미입력)'}
유형: ${type}

내용:
${message}`;

    const adminRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TimeLink B2B <' + fromEmail + '>',
        to: [toEmail],
        reply_to: email,
        subject: '[TimeLink B2B] ' + company + ' - ' + type,
        html: adminHtml,
        text: adminText
      })
    });

    if(!adminRes.ok){
      const errText = await adminRes.text().catch(() => '');
      console.error('Resend 오류:', errText);
      return c.json({ ok: false, error: '이메일 전송 실패: ' + errText.slice(0, 200) }, 500);
    }

    // ── 2) 투자 자료 자동 발송 (isInvest) ──
    if(isInvest){
      const investorHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#f5f5f7;padding:24px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0071E3,#64D2FF);padding:36px 28px;color:#fff">
      <h1 style="margin:0;font-size:26px;font-weight:700">TimeLink</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:.9">시간 기반 디지털 경제 플랫폼</p>
    </div>
    <div style="padding:36px 28px">
      <h2 style="margin:0 0 16px;font-size:20px;color:#1d1d1f">${escHtml(name)}님, 안녕하세요.</h2>
      <p style="font-size:15px;line-height:1.7;color:#424245;margin:0 0 20px">
        TimeLink 투자 자료를 요청해주셔서 감사합니다.<br>
        요청하신 사업계획서(PDF)를 첨부드립니다.
      </p>
      <div style="background:#f5f5f7;border-radius:12px;padding:20px;margin:24px 0">
        <div style="font-size:12px;color:#86868b;margin-bottom:8px;letter-spacing:.05em">첨부 파일</div>
        <div style="font-size:15px;font-weight:600;color:#1d1d1f">📄 TimeLink 사업계획서.pdf</div>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#424245;margin:20px 0 0">
        추가 문의는 <a href="mailto:mununglee@gmail.com" style="color:#0071E3;text-decoration:none">mununglee@gmail.com</a>으로 연락주시기 바랍니다.
      </p>
    </div>
    <div style="padding:20px 28px;background:#f5f5f7;font-size:11px;color:#86868b;text-align:center">
      TimeLink · 특허 출원 10-2025-0167813<br>
      © 2026 TimeLink. All rights reserved.
    </div>
  </div>
</body></html>`;

      // PDF 파일을 R2나 D1에서 읽어 base64로 변환
      let pdfBase64 = '';
      try {
        // D1 Object Storage에서 PDF 읽기 시도
        const pdfKey = 'docs/timelink-business-plan.pdf';
        const { getD1ObjectMeta, readD1Range } = await import('../d1-storage');
        const meta = await getD1ObjectMeta(c.env.DB, pdfKey);
        if(meta){
          const bytes = await readD1Range(c.env.DB, pdfKey, 0, meta.size);
          // Uint8Array → base64
          let binary = '';
          const chunk = 8192;
          for(let i = 0; i < bytes.length; i += chunk){
            binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + chunk)));
          }
          pdfBase64 = btoa(binary);
        }
      } catch(pdfErr){
        console.warn('PDF 읽기 실패:', pdfErr);
      }

      const investorEmail: any = {
        from: 'TimeLink <' + fromEmail + '>',
        to: [email],
        subject: '[TimeLink] 요청하신 투자 자료를 보내드립니다',
        html: investorHtml
      };

      if(pdfBase64){
        investorEmail.attachments = [{
          filename: 'TimeLink_사업계획서.pdf',
          content: pdfBase64
        }];
      }

      const investorRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(investorEmail)
      });

      if(!investorRes.ok){
        const errText = await investorRes.text().catch(() => '');
        console.error('투자자 발송 실패:', errText);
        // 사장님 알림은 성공했으니 부분 성공으로 처리
      }
    }

    return c.json({ ok: true });
  } catch(e: any){
    console.error('B2B contact error:', e);
    return c.json({ ok: false, error: e?.message || '문의 전송 실패' }, 500);
  }
});

function escHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default router;
