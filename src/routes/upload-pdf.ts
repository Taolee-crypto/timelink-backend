import { Hono } from 'hono';
import type { Env } from '../types';
import { putD1Object, ensureD1Storage } from '../d1-storage';

const router = new Hono<{ Bindings: Env }>();

// ── POST /api/upload-pdf (임시) ──
// 주의: 작업 후 삭제 권장 (관리자 토큰 필요)
router.post('/', async (c) => {
  try {
    const auth = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();
    if(auth !== 'timelink-upload-2026') {
      return c.json({ ok: false, error: '인증 실패' }, 401);
    }

    const contentType = c.req.header('Content-Type') || '';
    if(!contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')){
      return c.json({ ok: false, error: 'PDF만 업로드 가능' }, 400);
    }

    const buffer = await c.req.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if(bytes.length < 10) return c.json({ ok: false, error: '파일이 너무 작음' }, 400);
    if(bytes.length > 10 * 1024 * 1024) return c.json({ ok: false, error: '10MB 초과' }, 400);

    await ensureD1Storage(c.env.DB);
    const key = 'docs/timelink-business-plan.pdf';
    await putD1Object(c.env.DB, key, bytes, 'application/pdf');
    return c.json({ ok: true, key, size: bytes.length });
  } catch(e: any){
    return c.json({ ok: false, error: e?.message || '업로드 실패' }, 500);
  }
});

export default router;
