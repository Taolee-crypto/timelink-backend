import { Hono } from 'hono';
import type { Env } from '../types';
import { resolveTiloRegion, tiloEditorialInstruction } from '../tilo-v5-regional-editorial';

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


// Country-local weather from Open-Meteo; no API key or browser-side credentials.
// Weather is observational context, not a substitute for verified news.
const tiloWeatherCities:Record<string,{lat:number;lon:number;city:string}>={
 KR:{lat:37.5665,lon:126.9780,city:'Seoul'},
 JP:{lat:35.6762,lon:139.6503,city:'Tokyo'},
 US:{lat:38.9072,lon:-77.0369,city:'Washington DC'},
 CN:{lat:39.9042,lon:116.4074,city:'Beijing'},
 TH:{lat:13.7563,lon:100.5018,city:'Bangkok'},
 VN:{lat:21.0285,lon:105.8542,city:'Hanoi'}
};
router.get('/tilo/weather/:country',async c=>{
 const country=String(c.req.param('country')||'').toUpperCase();
 const city=tiloWeatherCities[country];
 if(!city)return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
 try{
   const url='https://api.open-meteo.com/v1/forecast?latitude='+city.lat+'&longitude='+city.lon+
     '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto';
   const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw Error('WEATHER_PROVIDER_HTTP_'+response.status);
   const data:any=await response.json();
   if(!data.current||!Number.isFinite(data.current.temperature_2m))throw Error('WEATHER_DATA_INVALID');
   return c.json({ok:true,country,city:city.city,observed_at:data.current.time,
     temperature_c:data.current.temperature_2m,humidity_percent:data.current.relative_humidity_2m,
     precipitation_mm:data.current.precipitation,weather_code:data.current.weather_code,
     wind_kmh:data.current.wind_speed_10m,source:'Open-Meteo',
     source_url:'https://open-meteo.com/',note:'Representative city conditions, not entire country.'},
     200,{'Cache-Control':'public, max-age=600'});
 }catch(e:any){return c.json({ok:false,error:'WEATHER_UNAVAILABLE'},503);}
});

// TILO daily editorial judgment. Verified news is provided by the caller; no invented headlines.
// This is a read-only advisory endpoint and cannot enable a country station or alter playback.
router.post('/tilo/daily-context/:country', async (c) => {
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const profile=resolveTiloRegion(country);
  const body=await c.req.json<any>().catch(()=>({}));
  const now=new Date();
  const localTime=new Intl.DateTimeFormat(profile.locale,{timeZone:profile.timeZone,dateStyle:'full',timeStyle:'short'}).format(now);
  const headlines=(Array.isArray(body.headlines)?body.headlines:[]).filter((x:any)=>
    x && x.verified===true && x.permittedForBroadcast===true &&
    typeof x.headline==='string' && typeof x.source==='string' &&
    /^https:\/\//.test(String(x.sourceUrl||'')) &&
    Number.isFinite(Date.parse(String(x.publishedAt||''))) &&
    Date.parse(String(x.publishedAt))<=now.getTime() &&
    Date.parse(String(x.publishedAt))>=now.getTime()-36*3600000
  ).slice(0,12).map((x:any)=>({headline:String(x.headline).slice(0,250),source:String(x.source).slice(0,100),sourceUrl:String(x.sourceUrl).slice(0,500)}));
  // Weather is fetched by the backend from a named provider; client claims are not trusted.
  let liveWeather:any=null;
  try{
    const city=tiloWeatherCities[country];
    const response=await fetch('https://api.open-meteo.com/v1/forecast?latitude='+city.lat+'&longitude='+city.lon+
      '&current=temperature_2m,precipitation,weather_code&timezone=auto',{signal:AbortSignal.timeout(3500)});
    if(response.ok){const result:any=await response.json();if(Number.isFinite(result.current?.temperature_2m))
      liveWeather={description:city.city+': '+result.current.temperature_2m+'°C, precipitation '+result.current.precipitation+' mm, WMO code '+result.current.weather_code,source:'Open-Meteo'};}
  }catch(_){/* Continue with no weather. */}
  const weather=liveWeather || (body.weather && body.weather.verified===true ? {
    description:String(body.weather.description||'').slice(0,180),
    source:String(body.weather.source||'').slice(0,100)
  }:null;
  const prompt=[
    'Local time: '+localTime,
    'Verified headlines: '+JSON.stringify(headlines),
    'Verified weather: '+JSON.stringify(weather),
    'Create an editorial plan for the current radio day, not a news article.',
    'Return only JSON with keys: day_mood (calm|neutral|bright|solemn), music_moods (array of 2-4 from acoustic,pop,jazz,indie,ballad,lofi,ambient,classical), speak_now (boolean), commentary (short natural DJ sentence in locale), rationale (short explanation), confidence (low|medium|high).',
    'Decide whether silence between songs is more appropriate than commentary.',
    'No claims about real-world events unless included in verified headlines. If there are no verified headlines, do not mention news or make event-specific claims.',
    'A verified headline does not automatically imply national mourning. Avoid unsupported inferences, political endorsements and sensationalism.'
  ].join('\n');
  try{
    const reply=await callGemini(c,tiloEditorialInstruction(profile),prompt,600);
    const match=reply.match(/\{[\s\S]*\}/);
    if(!match)throw Error('AI_JSON_INVALID');
    const plan=JSON.parse(match[0]);
    const moods=['acoustic','pop','jazz','indie','ballad','lofi','ambient','classical'];
    const dayMood=['calm','neutral','bright','solemn'].includes(plan.day_mood)?plan.day_mood:'neutral';
    return c.json({ok:true,country,locale:profile.locale,local_time:localTime,news_count:headlines.length,
      plan:{day_mood:dayMood,music_moods:(Array.isArray(plan.music_moods)?plan.music_moods:[]).filter((x:any)=>moods.includes(x)).slice(0,4),
      speak_now:plan.speak_now===true,commentary:String(plan.commentary||'').slice(0,600),
      rationale:String(plan.rationale||'').slice(0,400),confidence:['low','medium','high'].includes(plan.confidence)?plan.confidence:'low'},
      broadcast_started:false,station_approval_unchanged:true});
  }catch(e:any){return c.json({ok:false,error:'DAILY_CONTEXT_UNAVAILABLE',detail:String(e?.message||e).slice(0,180)},503);}
});

// Public read-only regional configuration. No untrusted news is treated as verified.
router.get('/regional-profile/:country', (c) => {
  const country = c.req.param('country').trim().toUpperCase();
  if (!['KR', 'JP', 'US', 'CN', 'TH', 'VN'].includes(country))
    return c.json({ ok: false, error: 'Unsupported broadcast country' }, 400);
  const profile = resolveTiloRegion(country);
  return c.json({
    ok: true,
    station: profile,
    editorialInstruction: tiloEditorialInstruction(profile),
    news: [],
    newsStatus: 'awaiting_verified_provider',
    voiceStatus: 'not_configured'
  }, 200, { 'Cache-Control': 'public, max-age=300' });
});

export default router;
