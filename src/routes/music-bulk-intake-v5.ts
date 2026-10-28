import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { putD1Object, ensureD1Storage } from '../d1-storage';

// Metadata-only intake. No third-party audio download, publishing or royalty assignment.
// Rights and source evidence must be reviewed before any TL3 conversion.
const app=new Hono<{Bindings:Env}>();
async function member(c:any){const raw=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();if(!raw)return null;try{const claim=await verifyToken(raw,c.env.JWT_SECRET);const id=Number(claim?.sub||0);return Number.isSafeInteger(id)&&id>0?id:null;}catch{return null;}}
async function requireAdmin(c:any){const uid=await member(c);if(!uid)return {error:c.json({ok:false,code:'AUTH_REQUIRED'},401)};try{const row=await c.env.DB.prepare("SELECT role FROM users WHERE id=? LIMIT 1").bind(uid).first();if(!row||!['admin','super_admin'].includes(String((row as any).role)))return {error:c.json({ok:false,code:'FORBIDDEN'},403)};return {uid};}catch{return {error:c.json({ok:false,code:'ADMIN_CHECK_UNAVAILABLE'},503)};}}
async function init(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_music_bulk_batches(id TEXT PRIMARY KEY,created_by INTEGER NOT NULL,source_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'rights_review',total_items INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_music_bulk_candidates(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,source_url TEXT NOT NULL,license_url TEXT NOT NULL,license_code TEXT NOT NULL,recording_rights TEXT NOT NULL DEFAULT 'unverified',composition_rights TEXT NOT NULL DEFAULT 'unverified',commercial_use INTEGER NOT NULL DEFAULT 0,transformation_allowed INTEGER NOT NULL DEFAULT 0,territories TEXT NOT NULL DEFAULT 'unverified',genre TEXT,weather TEXT,daypart TEXT,mood TEXT,status TEXT NOT NULL DEFAULT 'rights_review',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(source_url,source_id))").run();
}
const countryCode=(value:any)=>{const v=String(value||'').trim().toUpperCase();return /^[A-Z]{2}$/.test(v)?v:null;};
const cleanTags=(value:any)=>Array.isArray(value)?value.filter((x:any)=>typeof x==='string').map((x:string)=>x.trim()).filter(Boolean).slice(0,12).map((x:string)=>x.slice(0,60)):[];
const allowed=['CC0','CC-BY-4.0','PUBLIC_DOMAIN_CLAIM','OTHER_LICENSE','UNKNOWN'];
app.post('/batches',async c=>{
 const gate=await requireAdmin(c);if(gate.error)return gate.error;const uid=gate.uid!;
 let payload:any;try{payload=await c.req.json()}catch{return c.json({ok:false,code:'INVALID_JSON'},400)}
 const source=String(payload.source_name||'').trim(),items=payload.items;
 if(!source||source.length>100||!Array.isArray(items)||items.length<1||items.length>100)return c.json({ok:false,code:'INVALID_BATCH'},400);
 const clean:any[]=[];
 for(const item of items){const title=String(item.title||'').trim(),artist=String(item.artist||'').trim(),sourceUrl=String(item.source_url||''),licenseUrl=String(item.license_url||''),sourceId=String(item.source_id||'').trim(),license=String(item.license_code||'UNKNOWN');
 if(!title||title.length>200||artist.length>200||!sourceId||sourceId.length>200||!/^https:\/\//.test(sourceUrl)||sourceUrl.length>1200||!/^https:\/\//.test(licenseUrl)||licenseUrl.length>1200||!allowed.includes(license))return c.json({ok:false,code:'INVALID_ITEM'},400);
 clean.push({title,artist,sourceUrl,licenseUrl,sourceId,license,genre:String(item.genre||'').slice(0,100),weather:String(item.weather||'').slice(0,60),daypart:String(item.daypart||'').slice(0,60),mood:String(item.mood||'').slice(0,60),country:countryCode(item.country),language:String(item.language||'').trim().slice(0,20),cultural_tags:cleanTags(item.cultural_tags),season:String(item.season||'').trim().slice(0,40),occasion:String(item.occasion||'').trim().slice(0,60)});
 }
 const batchId=crypto.randomUUID();try{await init(c.env.DB);await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS v5_music_candidate_localization(candidate_id TEXT PRIMARY KEY,country TEXT,language TEXT,cultural_tags TEXT NOT NULL DEFAULT '[]',season TEXT,occasion TEXT)").run();const statements=[c.env.DB.prepare("INSERT INTO v5_music_bulk_batches(id,created_by,source_name,total_items) VALUES(?,?,?,?)").bind(batchId,uid,source,clean.length)];for(const x of clean){const id=crypto.randomUUID();statements.push(c.env.DB.prepare("INSERT INTO v5_music_bulk_candidates(id,batch_id,source_id,title,artist,source_url,license_url,license_code,genre,weather,daypart,mood) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,batchId,x.sourceId,x.title,x.artist,x.sourceUrl,x.licenseUrl,x.license,x.genre,x.weather,x.daypart,x.mood));statements.push(c.env.DB.prepare("INSERT INTO v5_music_candidate_localization(candidate_id,country,language,cultural_tags,season,occasion) VALUES(?,?,?,?,?,?)").bind(id,x.country,x.language,JSON.stringify(x.cultural_tags),x.season,x.occasion));};await c.env.DB.batch(statements);return c.json({ok:true,batch_id:batchId,count:clean.length,status:'rights_review',downloaded:false,tl3_converted:false,published:false},201)}catch(e){return c.json({ok:false,code:'BATCH_STORE_FAILED'},503)}
});
app.get('/batches/:id',async c=>{const gate=await requireAdmin(c);if(gate.error)return gate.error;const uid=gate.uid!;try{await init(c.env.DB);const batch=await c.env.DB.prepare("SELECT * FROM v5_music_bulk_batches WHERE id=? AND created_by=?").bind(c.req.param('id'),uid).first();if(!batch)return c.json({ok:false,code:'NOT_FOUND'},404);const items=await c.env.DB.prepare("SELECT m.id,m.title,m.artist,m.license_code,m.recording_rights,m.composition_rights,m.status,m.genre,m.weather,m.daypart,m.mood,l.country,l.language,l.cultural_tags,l.season,l.occasion FROM v5_music_bulk_candidates m LEFT JOIN v5_music_candidate_localization l ON l.candidate_id=m.id WHERE m.batch_id=? LIMIT 100").bind(c.req.param('id')).all();return c.json({ok:true,batch,items:items.results||[]})}catch{return c.json({ok:false,code:'BATCH_UNAVAILABLE'},503)}});

// Administrator-only discovery of Internet Archive audio metadata.
// Returned candidates are never published or downloaded automatically.
app.get('/discover',async c=>{
 const gate=await requireAdmin(c);if(gate.error)return gate.error;
 const term=String(c.req.query('q')||'classical').trim().slice(0,70);
 const page=Math.max(1,Math.min(100,Number(c.req.query('page')||1)||1));
 const query='mediatype:audio AND ('+term.replace(/[^\p{L}\p{N} \-]/gu,'').split(/\s+/).filter(Boolean).slice(0,5).map(w=>'title:'+w).join(' AND ')+')';
 const params=new URLSearchParams({q:query,output:'json',rows:'50',page:String(page)});
 for(const field of ['identifier','title','creator','licenseurl','rights','subject','date'])params.append('fl[]',field);
 try{
 const response=await fetch('https://archive.org/advancedsearch.php?'+params.toString(),{signal:AbortSignal.timeout(10000)});
 if(!response.ok)return c.json({ok:false,code:'SOURCE_UNAVAILABLE'},502);
 const data:any=await response.json();
 const items=(data.response?.docs||[]).map((x:any)=>({source_id:String(x.identifier||''),title:String(x.title||''),artist:Array.isArray(x.creator)?x.creator.join(', '):String(x.creator||''),source_url:'https://archive.org/details/'+encodeURIComponent(String(x.identifier||'')),license_url:String(x.licenseurl||''),license_code:'UNKNOWN',rights_note:String(x.rights||''),subject:x.subject||[],status:'rights_review',genre:null,weather:null,daypart:null,mood:null}));
 return c.json({ok:true,source:'Internet Archive',query:term,page,total:Number(data.response?.numFound||0),items,rights_verified:false,audio_downloaded:false});
 }catch{return c.json({ok:false,code:'SOURCE_UNAVAILABLE'},502)}
});


// Admin-controlled source staging. Never publishes raw MP3 or marks it TL3.
app.post('/candidates/:id/stage-source',async c=>{
 const gate=await requireAdmin(c);if(gate.error)return gate.error;
 const id=c.req.param('id');
 const item=await c.env.DB.prepare(`SELECT m.*,b.created_by FROM v5_music_bulk_candidates m
   JOIN v5_music_bulk_batches b ON b.id=m.batch_id WHERE m.id=?`).bind(id).first<any>().catch(()=>null);
 if(!item||Number(item.created_by)!==gate.uid)return c.json({ok:false,code:'NOT_FOUND'},404);
 if(item.recording_rights!=='verified'||item.composition_rights!=='verified'||
    Number(item.commercial_use)!==1||Number(item.transformation_allowed)!==1||
    !item.territories||item.territories==='unverified')
   return c.json({ok:false,code:'RIGHTS_NOT_VERIFIED'},409);
 let u:URL;try{u=new URL(String(item.source_url));}catch{return c.json({ok:false,code:'INVALID_SOURCE'},400)}
 // Only direct Archive file URLs are accepted. No arbitrary URL fetch or redirects.
 if(u.protocol!=='https:'||u.hostname!=='archive.org'||!u.pathname.startsWith('/download/')||
    u.username||u.password||u.port)return c.json({ok:false,code:'SOURCE_NOT_ALLOWED'},400);
 try{
   const res=await fetch(u.toString(),{redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!res.ok)return c.json({ok:false,code:'DOWNLOAD_FAILED'},502);
   const len=Number(res.headers.get('content-length')||0);
   if(len>16*1024*1024)return c.json({ok:false,code:'SOURCE_TOO_LARGE'},413);
   const raw=new Uint8Array(await res.arrayBuffer());
   if(raw.byteLength<128||raw.byteLength>16*1024*1024)return c.json({ok:false,code:'INVALID_SIZE'},422);
   const id3=raw[0]===73&&raw[1]===68&&raw[2]===51;
   const frame=raw[0]===255&&(raw[1]&224)===224;
   if(!id3&&!frame)return c.json({ok:false,code:'NOT_MP3'},422);
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw))).map(x=>x.toString(16).padStart(2,'0')).join('');
   const key='bulk-source/'+id+'/'+hash+'.mp3';
   await ensureD1Storage(c.env.DB);
   await putD1Object(c.env.DB,key,raw,'audio/mpeg',id+'.mp3');
   await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS v5_music_source_staging(
      candidate_id TEXT PRIMARY KEY,object_key TEXT NOT NULL,sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'awaiting_tl3',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
   await c.env.DB.prepare(`INSERT INTO v5_music_source_staging(candidate_id,object_key,sha256,size_bytes)
      VALUES(?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET
      object_key=excluded.object_key,sha256=excluded.sha256,size_bytes=excluded.size_bytes,status='awaiting_tl3'`)
      .bind(id,key,hash,raw.byteLength).run();
   return c.json({ok:true,candidate_id:id,source_staged:true,source_sha256:hash,
     tl3_converted:false,published:false,next:'TL3 V5 manufacture adapter required'});
 }catch{return c.json({ok:false,code:'SOURCE_STAGING_FAILED'},503)}
});


const discoveryCountries:Record<string,string>={
 KR:'Korea',JP:'Japan',CN:'China',IN:'India',US:'United States',GB:'United Kingdom',
 FR:'France',DE:'Germany',IT:'Italy',ES:'Spain',BR:'Brazil',MX:'Mexico',
 AR:'Argentina',NG:'Nigeria',ZA:'South Africa',EG:'Egypt',TR:'Turkey',
 ID:'Indonesia',TH:'Thailand',VN:'Vietnam',PH:'Philippines',AU:'Australia',
 CA:'Canada',RU:'Russia',UA:'Ukraine',SE:'Sweden',NO:'Norway'
};
const musicalStyles:Record<string,string[]>={
 KR:['gugak','pansori','minyo','trot','k-pop'],JP:['enka','shamisen','gagaku','j-pop'],
 IN:['raga','hindustani','carnatic','bollywood'],US:['bluegrass','gospel','country','soul'],
 BR:['samba','bossa nova','forro','choro'],AR:['tango','milonga'],
 NG:['afrobeat','highlife','juju'],ES:['flamenco'],TR:['makam','arabesque'],
 ID:['gamelan','dangdut'],CN:['guqin','erhu','pipa'],FR:['chanson'],
 EG:['maqam'],MX:['mariachi','ranchera'],ZA:['amapiano','kwaito']
};
function classifyCountryStyles(country:string,subjects:unknown,title:unknown){
 const tags=(Array.isArray(subjects)?subjects:[subjects]).filter(x=>typeof x==='string').map(x=>String(x).toLowerCase());
 const haystack=[...tags,String(title||'').toLowerCase()].join(' ');
 return (musicalStyles[country]||[]).filter(style=>haystack.includes(style));
}
const discoveryGenres=['classical','jazz','ambient','folk','blues','electronic','rock','hip hop','world','instrumental'];
function classifyAudio(subject:unknown,title:unknown){
 const tags=(Array.isArray(subject)?subject:[subject]).filter(x=>typeof x==='string').map(x=>String(x).toLowerCase().slice(0,100));
 const haystack=[...tags,String(title||'').toLowerCase()].join(' ');
 const genre=discoveryGenres.find(g=>haystack.includes(g))||'unclassified';
 const languageMatch=tags.find(x=>/^language:/.test(x));
 return {genre,language:languageMatch?languageMatch.slice(9).trim().slice(0,20):null,
   tags:tags.slice(0,12),classification_status:'provisional_metadata',confidence:'unverified'};
}
// Explicitly triggered bounded discovery. Discovery never implies a license or downloads MP3.
app.post('/discover/import',async c=>{
 const gate=await requireAdmin(c);if(gate.error)return gate.error;
 let body:any;try{body=await c.req.json()}catch{return c.json({ok:false,code:'INVALID_JSON'},400)}
 const country=String(body.country||'').toUpperCase();
 if(country!=='ALL'&&!discoveryCountries[country])return c.json({ok:false,code:'INVALID_COUNTRY',allowed:['ALL',...Object.keys(discoveryCountries)]},400);
 const genre=String(body.genre||'classical').toLowerCase();
 if(genre!=='all'&&!discoveryGenres.includes(genre))return c.json({ok:false,code:'INVALID_GENRE',allowed:['all',...discoveryGenres]},400);
 const page=Number(body.page||1);
 if(!Number.isSafeInteger(page)||page<1||page>100)return c.json({ok:false,code:'INVALID_PAGE'},400);
 const terms=['mediatype:audio'];
 if(genre!=='all')terms.push('subject:"'+genre+'"');
 if(country!=='ALL')terms.push('subject:"'+discoveryCountries[country]+'"');
 const params=new URLSearchParams({q:terms.join(' AND '),output:'json',rows:'40',page:String(page)});
 for(const key of ['identifier','title','creator','licenseurl','rights','subject','language'])params.append('fl[]',key);
 let docs:any[];
 try{
   const response=await fetch('https://archive.org/advancedsearch.php?'+params,{redirect:'error',signal:AbortSignal.timeout(12000)});
   if(!response.ok)return c.json({ok:false,code:'DISCOVERY_SOURCE_FAILED'},502);
   const json:any=await response.json();docs=Array.isArray(json.response?.docs)?json.response.docs:[];
 }catch{return c.json({ok:false,code:'DISCOVERY_SOURCE_UNAVAILABLE'},502)}
 await init(c.env.DB);
 await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS v5_music_candidate_localization(candidate_id TEXT PRIMARY KEY,country TEXT,language TEXT,cultural_tags TEXT NOT NULL DEFAULT '[]',season TEXT,occasion TEXT)`).run();
 await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS v5_music_candidate_classification(
 candidate_id TEXT PRIMARY KEY,classification_status TEXT NOT NULL,
 detected_genre TEXT,source_subjects TEXT NOT NULL DEFAULT '[]',
 detected_language TEXT,discovery_country TEXT,musical_styles TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
 const columns=await c.env.DB.prepare('PRAGMA table_info(v5_music_candidate_classification)').all<any>();
 if(!(columns.results||[]).some((x:any)=>x.name==='discovery_country'))await c.env.DB.prepare('ALTER TABLE v5_music_candidate_classification ADD COLUMN discovery_country TEXT').run();
 if(!(columns.results||[]).some((x:any)=>x.name==='musical_styles'))await c.env.DB.prepare("ALTER TABLE v5_music_candidate_classification ADD COLUMN musical_styles TEXT NOT NULL DEFAULT '[]'").run();
 const batchId=crypto.randomUUID();
 await c.env.DB.prepare("INSERT INTO v5_music_bulk_batches(id,created_by,source_name,total_items) VALUES(?,?,?,?)")
   .bind(batchId,gate.uid,'Internet Archive discovery: '+country+'/'+genre,0).run();
 let imported=0,skipped=0;
 for(const doc of docs){
   const sourceId=String(doc.identifier||'');
   if(!/^[A-Za-z0-9_.-]{1,200}$/.test(sourceId)){skipped++;continue}
   const title=String(doc.title||'').trim().slice(0,200);
   const artist=(Array.isArray(doc.creator)?doc.creator.join(', '):String(doc.creator||'Unknown')).slice(0,200);
   if(!title){skipped++;continue}
   const sourceUrl='https://archive.org/details/'+encodeURIComponent(sourceId);
   const licenseUrl=typeof doc.licenseurl==='string'&&doc.licenseurl.startsWith('https://')?doc.licenseurl:'https://archive.org/details/'+encodeURIComponent(sourceId);
   const classification=classifyAudio(doc.subject,title);
   const id=crypto.randomUUID();
   const inserted=await c.env.DB.prepare(`INSERT OR IGNORE INTO v5_music_bulk_candidates
   (id,batch_id,source_id,title,artist,source_url,license_url,license_code,genre,status)
   VALUES(?,?,?,?,?,?,?,'UNKNOWN',?,'rights_review')`)
   .bind(id,batchId,sourceId,title,artist,sourceUrl,licenseUrl,classification.genre).run();
   if(!inserted.meta?.changes){skipped++;continue}
   const styles=classifyCountryStyles(country,doc.subject,title);
   await c.env.DB.prepare(`INSERT INTO v5_music_candidate_localization(candidate_id,country,language,cultural_tags) VALUES(?,?,?,?)`).bind(id,null,classification.language,JSON.stringify(styles)).run();
   await c.env.DB.prepare(`INSERT INTO v5_music_candidate_classification
   (candidate_id,classification_status,detected_genre,source_subjects,detected_language,discovery_country,musical_styles)
   VALUES(?,?,?,?,?,?,?)`).bind(id,classification.classification_status,classification.genre,JSON.stringify(classification.tags),classification.language,country,JSON.stringify(styles)).run();
   imported++;
 }
 await c.env.DB.prepare('UPDATE v5_music_bulk_batches SET total_items=? WHERE id=?').bind(imported,batchId).run();
 return c.json({ok:true,batch_id:batchId,country,genre,page,discovered:docs.length,imported,skipped,
   classification:'provisional_metadata',rights_verified:false,mp3_downloaded:false,tl3_converted:false,published:false});
});
app.get('/discovery/genres',async c=>{
 const gate=await requireAdmin(c);if(gate.error)return gate.error;
 return c.json({ok:true,countries:{ALL:'모두',...discoveryCountries},musical_styles:musicalStyles,genres:['all',...discoveryGenres],classification:'provisional_metadata',source:'Internet Archive'});
});

export default app;
