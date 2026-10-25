export const CREATOR_SPLIT_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS v5_creator_split_heads(file_id INTEGER PRIMARY KEY,version INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS v5_creator_split_versions(file_id INTEGER NOT NULL,version INTEGER NOT NULL,owner_user_id INTEGER NOT NULL,total_bps INTEGER NOT NULL CHECK(total_bps BETWEEN 0 AND 10000),created_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(file_id,version))`,
 `CREATE TABLE IF NOT EXISTS v5_creator_split_members(id TEXT PRIMARY KEY,file_id INTEGER NOT NULL,version INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('lyrics','composition','arrangement','master')),name TEXT NOT NULL,share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 0 AND 10000),phone_hash TEXT,phone_last4 TEXT,recipient_user_id INTEGER,consent TEXT NOT NULL DEFAULT 'pending' CHECK(consent IN ('pending','accepted','rejected')),consented_at TEXT,UNIQUE(file_id,version,role,phone_hash))`,
 `CREATE TABLE IF NOT EXISTS v5_creator_verified_phones(user_id INTEGER PRIMARY KEY,phone_hash TEXT NOT NULL UNIQUE,phone_last4 TEXT NOT NULL,verified_at TEXT NOT NULL DEFAULT(datetime('now')))`,
 `CREATE TABLE IF NOT EXISTS v5_creator_phone_challenges(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,phone_hash TEXT NOT NULL,phone_last4 TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending')`
];
export async function ensureCreatorSplitSchema(db:D1Database){await db.batch(CREATOR_SPLIT_SCHEMA.map(sql=>db.prepare(sql)));}
export function normalizePhone(value:unknown){const phone=String(value||'').replace(/[\s()-]/g,'');if(!/^\+[1-9]\d{7,14}$/.test(phone))throw new Error('PHONE_E164_REQUIRED');return phone;}
export async function hashPhone(phone:string,secret:string){
 if(!secret)throw new Error('PHONE_HASH_SECRET_MISSING');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('creator-phone-v1:'+phone)))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function percentageToBps(value:unknown){const s=String(value??'').trim();if(!/^(?:\d{1,3})(?:\.\d{1,2})?$/.test(s))throw new Error('INVALID_SHARE_PERCENT');const [a,b='']=s.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(n>10000)throw new Error('INVALID_SHARE_PERCENT');return n;}
export async function readCreatorSplit(db:D1Database,fileId:number){
 const query=()=>db.prepare(`SELECT m.id,m.role,m.name,m.share_bps,m.phone_last4,m.recipient_user_id,m.consent,h.version,v.total_bps,
  CASE WHEN u.id IS NOT NULL AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0 THEN 1 ELSE 0 END AS active_recipient
  FROM v5_creator_split_heads h JOIN v5_creator_split_versions v ON v.file_id=h.file_id AND v.version=h.version
  JOIN v5_creator_split_members m ON m.file_id=h.file_id AND m.version=h.version
  LEFT JOIN users u ON u.id=m.recipient_user_id WHERE h.file_id=? ORDER BY m.id`).bind(fileId).all<any>();
 let rows:any[];
 try{rows=(await query()).results||[];}catch(e){if(/no such table.*v5_creator_split_/i.test(String(e)))return null;throw e;}
 if(!rows.length)return null;
 const total=rows.reduce((n,r)=>n+Number(r.share_bps),0);
 return {version:Number(rows[0].version),basis:'rights_holder_pool',total_bps:total,
  ready:total===10000&&rows.every(r=>r.consent==='accepted'&&r.active_recipient===1&&Number(r.recipient_user_id)>0),members:rows};
}
/** Exact integer atoms; fractional remainders are assigned deterministically. */
export function allocateCreatorAtoms(total:number,members:readonly {id:string;share_bps:number;recipient_user_id:number}[]){
 if(!Number.isSafeInteger(total)||total<0||members.reduce((n,m)=>n+m.share_bps,0)!==10000)throw new Error('INVALID_CREATOR_ALLOCATION');
 const rows=members.map(m=>{const scaled=BigInt(total)*BigInt(m.share_bps);return {...m,amount_atoms:Number(scaled/10000n),remainder:Number(scaled%10000n)};});
 let left=total-rows.reduce((n,r)=>n+r.amount_atoms,0);
 const order=[...rows].sort((a,b)=>b.remainder-a.remainder||a.id.localeCompare(b.id));for(let i=0;i<left;i++)order[i].amount_atoms++;
 return rows;
}
