import { Resend } from 'resend';

export function getResend(env: any) {
  return new Resend(env.RESEND_API_KEY);
}

export async function sendVerificationEmail(env: any, to: string, username: string, code: string) {
  const resend = getResend(env);
  const html = [
    '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#07070F;color:#F0F0FF;border-radius:12px">',
    '<div style="font-size:24px;font-weight:900;color:#00FF94;margin-bottom:8px">TL</div>',
    '<div style="font-size:18px;font-weight:700;margin-bottom:24px">TimeLink 이메일 인증</div>',
    '<p style="color:rgba(240,240,255,.7);margin-bottom:24px">안녕하세요, <b>' + username + '</b>님!<br>아래 인증 코드를 입력해 가입을 완료해주세요.</p>',
    '<div style="background:#12121F;border:1px solid rgba(0,255,148,.2);border-radius:10px;padding:24px;text-align:center;margin-bottom:24px">',
    '<div style="font-size:36px;font-weight:900;letter-spacing:.2em;color:#00FF94;font-family:monospace">' + code + '</div>',
    '<div style="font-size:12px;color:rgba(240,240,255,.4);margin-top:8px">10분 안에 입력해주세요</div>',
    '</div>',
    '<p style="font-size:12px;color:rgba(240,240,255,.3)">본인이 요청하지 않은 경우 이 이메일을 무시하세요.</p>',
    '</div>'
  ].join('');
  return await resend.emails.send({
    from: 'TimeLink <noreply@timelink.digital>',
    to,
    subject: '[TimeLink] 이메일 인증 코드',
    html,
  });
}

export async function sendPayoutEmail(env: any, to: string, username: string, amountTL: number, amountKRW: number) {
  const resend = getResend(env);
  const html = [
    '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#07070F;color:#F0F0FF;border-radius:12px">',
    '<div style="font-size:24px;font-weight:900;color:#00FF94;margin-bottom:8px">TL</div>',
    '<div style="font-size:18px;font-weight:700;margin-bottom:24px">정산 완료 안내</div>',
    '<p style="color:rgba(240,240,255,.7);margin-bottom:24px">안녕하세요, <b>' + username + '</b>님!<br>크리에이터 정산이 완료되었습니다.</p>',
    '<div style="background:#12121F;border:1px solid rgba(0,255,148,.2);border-radius:10px;padding:24px;margin-bottom:24px">',
    '<div style="display:flex;justify-content:space-between;margin-bottom:12px">',
    '<span style="color:rgba(240,240,255,.5)">정산 TL</span>',
    '<span style="color:#00FF94;font-weight:700;font-family:monospace">' + amountTL.toLocaleString() + ' TL</span>',
    '</div>',
    '<div style="display:flex;justify-content:space-between">',
    '<span style="color:rgba(240,240,255,.5)">원화 환산</span>',
    '<span style="color:#FFBE3D;font-weight:700;font-family:monospace">' + amountKRW.toLocaleString() + '원</span>',
    '</div></div>',
    '<p style="font-size:12px;color:rgba(240,240,255,.3)">문의: support@timelink.digital</p>',
    '</div>'
  ].join('');
  return await resend.emails.send({
    from: 'TimeLink <noreply@timelink.digital>',
    to,
    subject: '[TimeLink] 크리에이터 정산 완료',
    html,
  });
}
