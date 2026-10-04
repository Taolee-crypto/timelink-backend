import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

// ── Gemini API 호출 헬퍼 ──
async function callGemini(c: any, systemPrompt: string, userMessage: string, maxTokens = 500): Promise<string> {
  const apiKey = (c.env as any).GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY 없음');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + apiKey, {
    
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('Gemini API 오류 [' + res.status + ']: ' + errText.slice(0, 200));
  }
  const data: any = await res.json();
  return (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
}

// ── POST /api/dj/chat ──
// body: { system, messages, max_tokens }
router.post('/chat', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => ({}));
    const system = String(body.system || 'You are a helpful DJ assistant.');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const maxTokens = Math.min(Number(body.max_tokens || 500), 2000);
    const userMessage = messages.map((m: any) => String(m.content || '')).join('\n') || 'Hello';

    const reply = await callGemini(c, system, userMessage, maxTokens);
    return c.json({ ok: true, reply });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'AI DJ 오류' }, 500);
  }
});

// ── POST /api/dj/classify-mood ──
// body: { title, artist, category }
// 응답: { ok, mood }
router.post('/classify-mood', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => ({}));
    const title = String(body.title || '').trim();
    const artist = String(body.artist || '').trim();
    const category = String(body.category || '').trim();

    if (!title) return c.json({ ok: false, error: 'title 필요' }, 400);

    const system = [
      'You are a music mood classifier.',
      'Classify the song into ONE of these moods:',
      'acoustic, pop, jazz, indie, ballad, lofi, ambient, classical',
      '',
      'Return ONLY valid JSON: {"mood":"<mood>"}',
      'No explanation, no markdown.'
    ].join('\n');

    const userMsg = 'Title: ' + title + '\nArtist: ' + artist + '\nGenre: ' + category;

    const reply = await callGemini(c, system, userMsg, 100);
    console.log('[classify-mood] Gemini reply:', JSON.stringify(reply));
    const match = reply.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('JSON 파싱 실패: reply=' + reply.slice(0, 200));

    const parsed = JSON.parse(match[0]);
    const mood = String(parsed.mood || 'pop').toLowerCase();
    const allowed = ['acoustic','pop','jazz','indie','ballad','lofi','ambient','classical'];
    const finalMood = allowed.includes(mood) ? mood : 'pop';

    return c.json({ ok: true, mood: finalMood });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'mood 분류 실패' }, 500);
  }
});

// ── POST /api/dj/batch-classify ──
// body: { limit } — mood가 없는 곡들을 배치 분류
router.post('/batch-classify', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => ({}));
    const limit = Math.min(Number(body.limit || 20), 50);

    const { results } = await c.env.DB.prepare(
      "SELECT id, title, artist, category FROM tl_shares WHERE COALESCE(mood,'')='' LIMIT ?"
    ).bind(limit).all();

    const items = results || [];
    let updated = 0;
    const errors: string[] = [];

    for (const s of items as any[]) {
      try {
        const system = 'Classify song mood into ONE of: acoustic, pop, jazz, indie, ballad, lofi, ambient, classical. Return ONLY JSON: {"mood":"..."}';
        const userMsg = 'Title: ' + s.title + '\nArtist: ' + (s.artist||'') + '\nGenre: ' + (s.category||'');
        const reply = await callGemini(c, system, userMsg, 50);
        const match = reply.match(/\{[\s\S]*?\}/);
        if (!match) continue;
        const parsed = JSON.parse(match[0]);
        const mood = String(parsed.mood || 'pop').toLowerCase();
        const allowed = ['acoustic','pop','jazz','indie','ballad','lofi','ambient','classical'];
        const finalMood = allowed.includes(mood) ? mood : 'pop';
        await c.env.DB.prepare('UPDATE tl_shares SET mood=? WHERE id=?').bind(finalMood, s.id).run();
        updated++;
      } catch (e: any) {
        errors.push(s.id + ': ' + (e?.message || ''));
      }
    }

    return c.json({ ok: true, total: items.length, updated, errors: errors.slice(0, 5) });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '배치 분류 실패' }, 500);
  }
});

export default router;
