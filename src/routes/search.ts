import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

// ── GET /api/search/cafe?q=스타벅스 ──
// 카카오 로컬 API로 카페 검색 (서버 프록시)
router.get('/cafe', async (c) => {
  const q = String(c.req.query('q') || '').trim();
  if (!q) return c.json({ ok: false, error: '검색어를 입력해주세요.' }, 400);
  if (q.length < 2) return c.json({ ok: false, error: '검색어는 2자 이상이어야 합니다.' }, 400);

  const apiKey = c.env.KAKAO_REST_API_KEY;
  if (!apiKey) return c.json({ ok: false, error: '카카오 API 키가 설정되지 않았습니다.' }, 500);

  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&category_group_code=CE7&size=10`;
    const res = await fetch(url, {
      headers: { 'Authorization': `KakaoAK ${apiKey}` }
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return c.json({ ok: false, error: `카카오 API 오류 [${res.status}]`, detail: errText.slice(0, 200) }, 502);
    }

    const data: any = await res.json();
    const items = (data.documents || []).map((d: any) => ({
      id: d.id,
      name: d.place_name,
      category: d.category_name,
      address: d.address_name,          // 지번 주소
      road_address: d.road_address_name, // 도로명 주소
      phone: d.phone,
      lat: Number(d.y),                  // 위도
      lng: Number(d.x),                  // 경도
      place_url: d.place_url,
      distance: d.distance || ''
    }));

    return c.json({ ok: true, query: q, count: items.length, results: items });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '카페 검색 실패' }, 500);
  }
});

export default router;
