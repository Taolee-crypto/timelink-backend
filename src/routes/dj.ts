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
// Optional OpenWeatherMap global provider. Configure OPENWEATHER_API_KEY as a Worker secret.
// The existing Open-Meteo source remains a fallback until licensing is finalized.
// Diagnostics expose only safe status categories, never the API key or upstream URL.
router.get('/tilo/weather-status/:country',async c=>{
 const country=String(c.req.param('country')||'').toUpperCase();
 if(!tiloWeatherCities[country])return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
 const key=String((c.env as any)?.OPENWEATHER_API_KEY||'').trim();
 if(!key)return c.json({ok:false,provider:'OpenWeatherMap',status:'KEY_NOT_CONFIGURED',hint:'Add OPENWEATHER_API_KEY as a Secret to the deployed API Worker.'});
 const city=tiloWeatherCities[country];
 const url=new URL('https://api.openweathermap.org/data/2.5/weather');
 url.searchParams.set('lat',String(city.lat));url.searchParams.set('lon',String(city.lon));
 url.searchParams.set('appid',key);url.searchParams.set('units','metric');
 try{
   const response=await fetch(url.toString(),{signal:AbortSignal.timeout(4500)});
   if(response.status===401)return c.json({ok:false,provider:'OpenWeatherMap',status:'AUTH_FAILED',hint:'Verify key activation and value in the production Worker Secret.'});
   if(response.status===429)return c.json({ok:false,provider:'OpenWeatherMap',status:'RATE_LIMITED'});
   if(!response.ok)return c.json({ok:false,provider:'OpenWeatherMap',status:'UPSTREAM_HTTP_ERROR',http_status:response.status});
   const data:any=await response.json();
   if(!Number.isFinite(data?.main?.temp))return c.json({ok:false,provider:'OpenWeatherMap',status:'INVALID_WEATHER_RESPONSE'});
   return c.json({ok:true,provider:'OpenWeatherMap',status:'READY',country,city:city.city});
 }catch(_){return c.json({ok:false,provider:'OpenWeatherMap',status:'NETWORK_OR_TIMEOUT'});}
});

async function getOpenWeather(country:string,env:any,forecast=false):Promise<any|null>{
 const key=String(env?.OPENWEATHER_API_KEY||'').trim();
 const city=tiloWeatherCities[country];
 if(!key||!city)return null;
 const endpoint=forecast?'forecast':'weather';
 const url=new URL('https://api.openweathermap.org/data/2.5/'+endpoint);
 url.searchParams.set('lat',String(city.lat));url.searchParams.set('lon',String(city.lon));
 url.searchParams.set('appid',key);url.searchParams.set('units','metric');
 url.searchParams.set('lang',country==='KR'?'kr':country==='JP'?'ja':country==='CN'?'zh_cn':country==='TH'?'th':country==='VN'?'vi':'en');
 try{
   const response=await fetch(url.toString(),{signal:AbortSignal.timeout(4500)});
   if(!response.ok)return null;
   const data:any=await response.json();
   if(forecast){
     if(!Array.isArray(data.list))return null;
     const entries=data.list.slice(0,40).filter((x:any)=>Number.isFinite(x?.main?.temp)&&Number.isFinite(x?.dt)).map((x:any)=>({
       forecast_at:new Date(x.dt*1000).toISOString(),temperature_c:x.main.temp,
       description:String(x.weather?.[0]?.description||'').slice(0,100),
       humidity_percent:x.main.humidity,wind_kmh:Number.isFinite(x.wind?.speed)?Math.round(x.wind.speed*36)/10:null,
       rain_3h_mm:x.rain?.['3h']??0,snow_3h_mm:x.snow?.['3h']??0
     }));
     return {ok:true,country,city:city.city,source:'OpenWeatherMap',source_url:'https://openweathermap.org/',forecasts:entries};
   }
   if(!Number.isFinite(data.main?.temp)||!Number.isFinite(data.dt))return null;
   return {ok:true,country,city:city.city,observed_at:new Date(data.dt*1000).toISOString(),
     temperature_c:data.main.temp,feels_like_c:data.main.feels_like,humidity_percent:data.main.humidity,
     precipitation_mm:data.rain?.['1h']??0,snow_1h_mm:data.snow?.['1h']??0,
     weather_code:data.weather?.[0]?.id??null,description:String(data.weather?.[0]?.description||'').slice(0,100),
     wind_kmh:Number.isFinite(data.wind?.speed)?Math.round(data.wind.speed*36)/10:null,
     source:'OpenWeatherMap',source_url:'https://openweathermap.org/',note:'Representative city conditions, not entire country.'};
 }catch(_){return null;}
}
router.get('/tilo/forecast/:country',async c=>{
 const country=String(c.req.param('country')||'').toUpperCase();
 if(!tiloWeatherCities[country])return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
 const forecast=await getOpenWeather(country,c.env,true);
 return forecast?c.json(forecast,200,{'Cache-Control':'public, max-age=1800'}):c.json({ok:false,error:'FORECAST_PROVIDER_NOT_CONFIGURED_OR_UNAVAILABLE'},503);
});

router.get('/tilo/weather/:country',async c=>{
 const country=String(c.req.param('country')||'').toUpperCase();
 const city=tiloWeatherCities[country];
 if(!city)return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
 try{
   const openWeather=await getOpenWeather(country,c.env);
   if(openWeather)return c.json(openWeather,200,{'Cache-Control':'public, max-age=600'});
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
  let liveWeather:any=null;
  try{
    const current=await getOpenWeather(country,c.env);
    if(current)liveWeather={description:current.city+': '+current.temperature_c+'°C, '+current.description+', rain last hour '+current.precipitation_mm+' mm',source:current.source,weather_code:current.weather_code,observed_at:current.observed_at};
  }catch(_){/* Fall back to existing weather source. */}
  try{
    if(!liveWeather){
    const city=tiloWeatherCities[country];
    const response=await fetch('https://api.open-meteo.com/v1/forecast?latitude='+city.lat+'&longitude='+city.lon+
      '&current=temperature_2m,precipitation,weather_code&timezone=UTC',{signal:AbortSignal.timeout(3500)});
    if(response.ok){const result:any=await response.json();if(Number.isFinite(result.current?.temperature_2m))
      liveWeather={description:city.city+': '+result.current.temperature_2m+'°C, precipitation '+result.current.precipitation+' mm, WMO code '+result.current.weather_code,source:'Open-Meteo',weather_code:result.current.weather_code,observed_at:String(result.current.time||'')+'Z'};}
    }
  }catch(_){/* Continue with no weather. */}
  const weather=liveWeather;
  // A source-qualified observation is available even when optional AI
  // commentary is unavailable. No user-supplied weather can override it.
  const voiceContext=weather&&weather.weather_code!=null&&Number.isInteger(Number(weather.weather_code))?{
    weather_code:Number(weather.weather_code),source:weather.source,
    observed_at:weather.observed_at||null
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
       voice_context:voiceContext,
      plan:{day_mood:dayMood,music_moods:(Array.isArray(plan.music_moods)?plan.music_moods:[]).filter((x:any)=>moods.includes(x)).slice(0,4),
      speak_now:plan.speak_now===true,commentary:String(plan.commentary||'').slice(0,600),
      rationale:String(plan.rationale||'').slice(0,400),confidence:['low','medium','high'].includes(plan.confidence)?plan.confidence:'low'},
      broadcast_started:false,station_approval_unchanged:true});
  }catch(_){return c.json({ok:true,country,locale:profile.locale,local_time:localTime,
      news_count:headlines.length,voice_context:voiceContext,plan:null,editorial_available:false,
      note:'Optional AI editorial unavailable. Only original, local-language DJ greetings may be used; no news headlines are invented.'});}
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
