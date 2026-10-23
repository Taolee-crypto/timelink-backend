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
// Korea Meteorological Administration ASOS observation, Seoul station 108.
// The API Hub key must be configured as a Cloudflare secret: KMA_API_HUB_KEY.
// ASOS is line-oriented text, not JSON. Never expose authKey in responses.
async function getKmaSeoulWeather(env:any):Promise<any|null>{
 const key=String(env?.KMA_API_HUB_KEY||'').trim();
 if(!key)return null;
 try{
   const url=new URL('https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php');
   url.searchParams.set('stn','108');url.searchParams.set('help','0');url.searchParams.set('authKey',key);
   const response=await fetch(url.toString(),{signal:AbortSignal.timeout(4500)});
   if(!response.ok)return null;
   const raw=await response.text();
   // ASOS tm2 layout: TM STN WD WS GST_WD GST_WS GST_TM PA PS PT PR TA TD HM PV RN ...
   // Use the official field indices; reject missing (-9/-99) or malformed readings.
   const line=raw.split(/\r?\n/).find(x=>/^\d{12}\s+108\s/.test(x.trim()));
   if(!line)return null;
   const values=line.trim().split(/\s+/);
   const numeric=(i:number)=>{
     const v=Number(values[i]);
     return values[i]!==undefined&&Number.isFinite(v)&&v>-8.9?v:null;
   };
   const temperature=numeric(11),humidity=numeric(13),wind=numeric(3),rain=numeric(15);
   if(temperature===null||temperature < -90||temperature > 65)return null;
   const observed=values[0];
   const stamp=Date.parse(observed.slice(0,4)+'-'+observed.slice(4,6)+'-'+observed.slice(6,8)+'T'+observed.slice(8,10)+':'+observed.slice(10,12)+':00+09:00');
   if(!Number.isFinite(stamp)||stamp>Date.now()+600000||Date.now()-stamp>3*3600000)return null;
   return {ok:true,country:'KR',city:'Seoul',observed_at:observed.slice(0,4)+'-'+observed.slice(4,6)+'-'+observed.slice(6,8)+'T'+observed.slice(8,10)+':'+observed.slice(10,12),
     temperature_c:temperature,humidity_percent:humidity,precipitation_mm:rain,weather_code:null,
     wind_kmh:wind===null?null:Math.round(wind*36)/10,
     source:'KMA ASOS',source_url:'https://apihub.kma.go.kr/',note:'Seoul ASOS observation, not a national forecast.'};
 }catch(_){return null;}
}
async function getTiloWeather(country:string,env:any,timeoutMs=5000):Promise<any>{
 if(country==='KR'){
   const kma=await getKmaSeoulWeather(env);
   if(kma)return kma;
 }
 const city=tiloWeatherCities[country];
 if(!city)return null;
 const url='https://api.open-meteo.com/v1/forecast?latitude='+city.lat+'&longitude='+city.lon+
   '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto';
 const response=await fetch(url,{signal:AbortSignal.timeout(timeoutMs)});
 if(!response.ok)throw Error('WEATHER_PROVIDER_HTTP_'+response.status);
 const data:any=await response.json();
 if(!data.current||!Number.isFinite(data.current.temperature_2m))throw Error('WEATHER_DATA_INVALID');
 return {ok:true,country,city:city.city,observed_at:data.current.time,
   temperature_c:data.current.temperature_2m,humidity_percent:data.current.relative_humidity_2m,
   precipitation_mm:data.current.precipitation,weather_code:data.current.weather_code,
   wind_kmh:data.current.wind_speed_10m,source:'Open-Meteo',
   source_url:'https://open-meteo.com/',note:'Representative city conditions, not entire country.'};
}

router.get('/tilo/weather/:country',async c=>{
 const country=String(c.req.param('country')||'').toUpperCase();
 const city=tiloWeatherCities[country];
 if(!city)return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
 try{
   const weather=await getTiloWeather(country,c.env);
   return c.json(weather,200,{'Cache-Control':'public, max-age=600'});
 }catch(e:any){return c.json({ok:false,error:'WEATHER_UNAVAILABLE'},503);}
});

// TILO daily editorial judgment. Verified news is provided by the caller; no invented headlines.
// This is a read-only advisory endpoint and cannot enable a country station or alter playback.
// Approved news is ingested only from operator-configured JSON endpoints.
// TILO_NEWS_FEEDS_JSON: {"KR":{"url":"https://licensed-provider.example/api/kr","source":"Publisher","broadcastPermitted":true},...}
// Endpoint returns {items:[{headline,sourceUrl,publishedAt},...]}; feed URLs must be HTTPS.
// No configuration means no news: public headlines cannot self-certify broadcast rights.
const tiloNewsCache=new Map<string,{expires:number;items:any[]}>();
async function getTiloApprovedNews(country:string,env:any,now:Date):Promise<any[]>{
  let feeds:any={};
  try{feeds=JSON.parse(String(env?.TILO_NEWS_FEEDS_JSON||'{}'));}catch(_){return [];}
  const feed=feeds?.[country];
  if(!feed||feed.broadcastPermitted!==true||typeof feed.url!=='string'||typeof feed.source!=='string')return [];
  let url:URL;
  try{url=new URL(feed.url);}catch(_){return [];}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password)return [];
  const cached=tiloNewsCache.get(country);
  if(cached&&cached.expires>now.getTime())return cached.items;
  try{
    const response=await fetch(url.toString(),{signal:AbortSignal.timeout(4500),headers:{Accept:'application/json'}});
    if(!response.ok)return cached?.items||[];
    const json:any=await response.json();
    const items=(Array.isArray(json?.items)?json.items:[]).filter((x:any)=>{
      const published=Date.parse(String(x?.publishedAt||''));
      if(!Number.isFinite(published)||published>now.getTime()||published<now.getTime()-36*3600000)return false;
      if(typeof x.headline!=='string'||!x.headline.trim()||typeof x.sourceUrl!=='string')return false;
      try{return new URL(x.sourceUrl).protocol==='https:';}catch(_){return false;}
    }).slice(0,12).map((x:any)=>({
      headline:String(x.headline).slice(0,250),
      source:String(feed.source).slice(0,100),
      sourceUrl:String(x.sourceUrl).slice(0,500),
      publishedAt:String(x.publishedAt)
    }));
    tiloNewsCache.set(country,{expires:now.getTime()+10*60000,items});
    return items;
  }catch(_){return cached?.items?.filter((x:any)=>Date.parse(x.publishedAt)>=now.getTime()-36*3600000)||[];}
}

router.post('/tilo/daily-context/:country', async (c) => {
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const profile=resolveTiloRegion(country);
  const body=await c.req.json<any>().catch(()=>({}));
  const now=new Date();
  const localTime=new Intl.DateTimeFormat(profile.locale,{timeZone:profile.timeZone,dateStyle:'full',timeStyle:'short'}).format(now);
  const headlines=await getTiloApprovedNews(country,c.env,now);
  // Weather is fetched by the backend from a named provider; client claims are not trusted.
  let weather:any=null;
  try{
    const observation=await getTiloWeather(country,c.env,3500);
    if(observation)weather={description:observation.city+': '+observation.temperature_c+'°C'+
      (observation.precipitation_mm===null?'':', precipitation '+observation.precipitation_mm+' mm')+
      (observation.weather_code===null?'':', WMO code '+observation.weather_code),
      source:observation.source,observed_at:observation.observed_at};
  }catch(_){/* AI can make a non-weather editorial plan. */}
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
