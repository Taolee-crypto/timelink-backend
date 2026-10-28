import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

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
 const batchId=crypto.randomUUID();try{await init(c.env.DB);await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS v5_music_candidate_localization(candidate_id TEXT PRIMARY KEY,country TEXT,language TEXT,cultural_tags TEXT NOT NULL DEFAULT '[]',season TEXT,occasion TEXT)").run();const statements=[c.env.DB.prepare("INSERT INTO v5_music_bulk_batches(id,created_by,source_name,total_items) VALUES(?,?,?,?)").bind(batchId,uid,source,clean.length),...clean.map(x=>c.env.DB.prepare("INSERT INTO v5_music_bulk_candidates(id,batch_id,source_id,title,artist,source_url,license_url,license_code,genre,weather,daypart,mood) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),batchId,x.sourceId,x.title,x.artist,x.sourceUrl,x.licenseUrl,x.license,x.genre,x.weather,x.daypart,x.mood))];await c.env.DB.batch(statements);return c.json({ok:true,batch_id:batchId,count:clean.length,status:'rights_review',downloaded:false,tl3_converted:false,published:false},201)}catch(e){return c.json({ok:false,code:'BATCH_STORE_FAILED'},503)}
});
app.get('/batches/:id',async c=>{const gate=await requireAdmin(c);if(gate.error)return gate.error;const uid=gate.uid!;try{await init(c.env.DB);const batch=await c.env.DB.prepare("SELECT * FROM v5_music_bulk_batches WHERE id=? AND created_by=?").bind(c.req.param('id'),uid).first();if(!batch)return c.json({ok:false,code:'NOT_FOUND'},404);const items=await c.env.DB.prepare("SELECT id,title,artist,license_code,recording_rights,composition_rights,status,genre,weather,daypart,mood FROM v5_music_bulk_candidates WHERE batch_id=? LIMIT 100").bind(c.req.param('id')).all();return c.json({ok:true,batch,items:items.results||[]})}catch{return c.json({ok:false,code:'BATCH_UNAVAILABLE'},503)}});

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

export default app;
