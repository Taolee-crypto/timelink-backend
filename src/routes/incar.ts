import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { putV5Object,deleteV5Object,readV5Object } from '../v5-object-store';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();
router.use('/channels/:id/photo',bodyLimit({maxSize:5*1024*1024}));

async function ensureVehicleListings(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_vehicle_listings(
    channel_id TEXT PRIMARY KEY,photo_key TEXT,photo_type TEXT,
    sale_status TEXT NOT NULL DEFAULT 'none',price INTEGER,currency TEXT DEFAULT 'KRW',
    model_year INTEGER,mileage_km INTEGER,description TEXT DEFAULT '',contact TEXT DEFAULT '',updated_at TEXT)`
  ).run();
}
router.get('/channels/:id',async c=>{
  await ensureIncarTables(c.env.DB);await ensureVehicleListings(c.env.DB);
  const channel=await c.env.DB.prepare(`SELECT channel_id,name,owner_name,car_type,drive_region,description,theme
    FROM incar_channels WHERE channel_id=? AND status='active'`).bind(c.req.param('id')).first<any>();
  if(!channel)return c.json({error:'CHANNEL_NOT_FOUND'},404);
  const listing=await c.env.DB.prepare('SELECT sale_status,price,currency,model_year,mileage_km,description,contact,photo_key FROM v5_vehicle_listings WHERE channel_id=?').bind(channel.channel_id).first<any>();
  const user=await authUser(c);
  const owned=user?await c.env.DB.prepare('SELECT 1 FROM incar_channels WHERE channel_id=? AND owner_id=?').bind(channel.channel_id,user.id).first():null;
  if(listing){listing.has_photo=!!listing.photo_key;delete listing.photo_key;}
  if(listing&&!owned&&listing.sale_status!=='sale')listing.contact='';
  return c.json({ok:true,channel,listing:listing||null,can_edit:!!owned});
});
router.post('/channels/:id/listing',async c=>{
  const user=await authUser(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  await ensureIncarTables(c.env.DB);await ensureVehicleListings(c.env.DB);
  const owned=await c.env.DB.prepare("SELECT 1 FROM incar_channels WHERE channel_id=? AND owner_id=? AND status='active'").bind(c.req.param('id'),user.id).first();
  if(!owned)return c.json({error:'OWNER_REQUIRED'},403);
  const b=await c.req.json<any>();
  const price=Number(b.price),year=Number(b.model_year),mileage=Number(b.mileage_km);
  if(!['none','sale','sold'].includes(b.sale_status)||!['KRW','USD','JPY','CNY','THB','VND'].includes(b.currency)||
    !Number.isSafeInteger(price)||price<0||price>1e12||!Number.isInteger(year)||year<1950||year>new Date().getFullYear()+1||
    !Number.isSafeInteger(mileage)||mileage<0||mileage>3000000||String(b.description||'').length>3000||String(b.contact||'').length>200)
    return c.json({error:'차량 연식·주행거리·가격·연락 방법을 확인하세요.'},400);
  await c.env.DB.prepare(`INSERT INTO v5_vehicle_listings(channel_id,sale_status,price,currency,model_year,mileage_km,description,contact,updated_at)
    VALUES(?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(channel_id) DO UPDATE SET sale_status=excluded.sale_status,
    price=excluded.price,currency=excluded.currency,model_year=excluded.model_year,mileage_km=excluded.mileage_km,
    description=excluded.description,contact=excluded.contact,updated_at=excluded.updated_at`)
    .bind(c.req.param('id'),b.sale_status,price,b.currency,year,mileage,String(b.description||'').trim(),String(b.contact||'').trim()).run();
  return c.json({ok:true});
});
router.post('/channels/:id/photo',async c=>{
  const user=await authUser(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  await ensureIncarTables(c.env.DB);await ensureVehicleListings(c.env.DB);
  const owned=await c.env.DB.prepare("SELECT 1 FROM incar_channels WHERE channel_id=? AND owner_id=? AND status='active'").bind(c.req.param('id'),user.id).first();
  if(!owned)return c.json({error:'OWNER_REQUIRED'},403);
  const b=await c.req.parseBody(),file=b.photo;
  if(!(file instanceof File)||file.size<=0||file.size>4*1024*1024)return c.json({error:'사진은 최대 4MB입니다.'},400);
  const bytes=new Uint8Array(await file.arrayBuffer());
  const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const png=bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10';
  const webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
  const type=jpg?'image/jpeg':png?'image/png':webp?'image/webp':null;
  if(!type)return c.json({error:'JPG·PNG·WebP 사진만 올릴 수 있습니다.'},400);
  const key='vehicle-photos/'+c.req.param('id')+'/'+crypto.randomUUID();
  await putV5Object(c.env,key,bytes,type);
  try{await c.env.DB.prepare(`INSERT INTO v5_vehicle_listings(channel_id,photo_key,photo_type,updated_at)
    VALUES(?,?,?,datetime('now')) ON CONFLICT(channel_id) DO UPDATE SET photo_key=excluded.photo_key,photo_type=excluded.photo_type,updated_at=excluded.updated_at`).bind(c.req.param('id'),key,type).run();}
  catch(e){await deleteV5Object(c.env,key);throw e;}
  return c.json({ok:true});
});
router.get('/channels/:id/photo',async c=>{
  await ensureIncarTables(c.env.DB);await ensureVehicleListings(c.env.DB);
  const row=await c.env.DB.prepare(`SELECT l.photo_key,l.photo_type FROM v5_vehicle_listings l JOIN incar_channels c ON c.channel_id=l.channel_id
    WHERE l.channel_id=? AND c.status='active'`).bind(c.req.param('id')).first<any>();
  if(!row?.photo_key)return c.notFound();
  const body=await readV5Object(c.env,row.photo_key);if(!body)return c.notFound();
  return new Response(body,{headers:{'Content-Type':row.photo_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
});

async function authUser(c: Context<{ Bindings: Env }>): Promise<{ id: number; user: any } | null> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const payload = await verifyToken(token, c.env.JWT_SECRET).catch(() => null);
  const id = Number(payload?.sub || 0);
  if (!id) return null;
  const user = await c.env.DB.prepare('SELECT id, email, username FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(id).first<any>();
  return user ? { id, user } : null;
}

async function ensureIncarTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS incar_channels (
    channel_id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    owner_name TEXT DEFAULT '',
    car_plate TEXT DEFAULT '',
    car_type TEXT DEFAULT '',
    drive_region TEXT DEFAULT '',
    description TEXT DEFAULT '',
    theme TEXT DEFAULT 'city',
    playlist TEXT DEFAULT '[]',
    schedules TEXT DEFAULT '[]',
    poc_index_at_creation REAL DEFAULT 1,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  // Existing production tables may predate fields added to the V5 channel model.
  // CREATE TABLE IF NOT EXISTS does not upgrade an existing schema.
  const columns = await db.prepare('PRAGMA table_info(incar_channels)').all();
  const existing = new Set((columns.results || []).map((row: any) => String(row.name)));
  const upgrades: Array<[string, string]> = [
    ['owner_name', "TEXT DEFAULT ''"],
    ['car_plate', "TEXT DEFAULT ''"],
    ['car_type', "TEXT DEFAULT ''"],
    ['drive_region', "TEXT DEFAULT ''"],
    ['description', "TEXT DEFAULT ''"],
    ['theme', "TEXT DEFAULT 'city'"],
    ['playlist', "TEXT DEFAULT '[]'"],
    ['schedules', "TEXT DEFAULT '[]'"],
    ['poc_index_at_creation', 'REAL DEFAULT 1'],
    ['status', "TEXT DEFAULT 'active'"],
    ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, definition] of upgrades) {
    if (!existing.has(name)) {
      try {
        await db.prepare(`ALTER TABLE incar_channels ADD COLUMN ${name} ${definition}`).run();
      } catch (error: any) {
        // Concurrent requests can race to add the same column; verify actual schema.
        const latest = await db.prepare('PRAGMA table_info(incar_channels)').all();
        if (!(latest.results || []).some((row: any) => row.name === name)) throw error;
      }
    }
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_incar_channels_owner ON incar_channels(owner_id)').run().catch(() => {});
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_incar_channels_status ON incar_channels(status, created_at)').run().catch(() => {});
}

router.get('/channels', async (c) => {
  try {
    await ensureIncarTables(c.env.DB);
    await ensureVehicleListings(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT c.channel_id,c.name,c.owner_name,c.car_type,c.drive_region,c.description,c.theme,c.playlist,c.schedules,c.created_at,
       CASE WHEN l.photo_key IS NOT NULL THEN 1 ELSE 0 END AS has_photo,l.sale_status,l.price,l.currency
       FROM incar_channels c LEFT JOIN v5_vehicle_listings l ON l.channel_id=c.channel_id
       WHERE c.status='active' ORDER BY c.created_at DESC LIMIT 100`
    ).all();
    return c.json({ ok: true, channels: results || [] });
  } catch (error: any) {
    return c.json({ ok: false, error: error?.message || '인카 채널 목록을 불러오지 못했습니다.' }, 500);
  }
});

router.get('/my-channel', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401);
  try {
    await ensureIncarTables(c.env.DB);
    const channel = await c.env.DB.prepare(
      `SELECT channel_id, name, owner_name, car_plate, car_type, drive_region, description, theme, playlist, schedules, created_at
       FROM incar_channels WHERE owner_id=? AND status='active' ORDER BY created_at DESC LIMIT 1`
    ).bind(auth.id).first<any>();
    return c.json({ ok: true, registered: !!channel, channel: channel || null });
  } catch (error: any) {
    return c.json({ ok: false, error: error?.message || '내 인카 채널 조회 실패' }, 500);
  }
});

router.post('/channel', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));
  const channelId = String(body.channel_id || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const carPlate = String(body.car_plate || '').trim().toUpperCase();
  const carType = String(body.car_type || '').trim();
  const driveRegion = String(body.drive_region || '').trim();
  const description = String(body.description || '').trim();
  const theme = String(body.theme || 'city').trim();
  const playlist = JSON.stringify(Array.isArray(body.playlist) ? body.playlist : []);
  const schedules = JSON.stringify(Array.isArray(body.schedules) ? body.schedules : []);
  const pocIndex = Math.max(1, Math.min(10, Number(body.poc_index_at_creation) || 1));

  if (!/^[a-z0-9_]{3,20}$/.test(channelId)) return c.json({ ok: false, error: '채널 ID는 영문 소문자·숫자·언더스코어 3~20자여야 합니다.' }, 400);
  if (!name || !carPlate || !carType) return c.json({ ok: false, error: '채널명, 차량번호, 차종은 필수입니다.' }, 400);

  try {
    await ensureIncarTables(c.env.DB);
    const existing = await c.env.DB.prepare('SELECT channel_id FROM incar_channels WHERE channel_id=?').bind(channelId).first<any>();
    if (existing) return c.json({ ok: false, error: '이미 사용 중인 채널 ID입니다.' }, 409);
  } catch (error: any) {
    console.error('[INCAR] channel preflight failed', error);
    return c.json({ ok: false, error: '인카 채널 데이터베이스 준비에 실패했습니다. 관리자에게 문의해 주세요.' }, 500);
  }

  // V5 policy: channel registration is free; actual listening is charged separately.
  // Do not debit legacy users.tl balances during registration.
  const fee = 0;

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO incar_channels
       (channel_id, owner_id, name, owner_name, car_plate, car_type, drive_region, description, theme, playlist, schedules, poc_index_at_creation, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(channelId, auth.id, name, String(auth.user.username || auth.user.email || ''), carPlate, carType, driveRegion, description, theme, playlist, schedules, pocIndex, 'active', now, now).run();
  } catch (error: any) {
    console.error('[INCAR] channel insert failed', error);
    const message = String(error?.message || '');
    if (/unique|constraint/i.test(message)) return c.json({ ok: false, error: '이미 사용 중인 채널 ID입니다.' }, 409);
    return c.json({ ok: false, error: '인카 채널 저장에 실패했습니다.' }, 500);
  }

  return c.json({ ok: true, channel_id: channelId, fee });
});


/** 차량 기여도 정책: 테스트는 정산 원장에 쓰지 않는다. */
async function ensureCarContributionPolicy(db:D1Database){
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_car_contribution_policy(
    id INTEGER PRIMARY KEY CHECK(id=1),
    multiplier REAL NOT NULL DEFAULT 2.5,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_by INTEGER,
    updated_at TEXT
  )`).run();
  await db.prepare('INSERT OR IGNORE INTO v5_car_contribution_policy(id,multiplier,enabled) VALUES(1,2.5,0)').run();
}
router.get('/contribution-policy',async c=>{
  const auth=await authUser(c);if(!auth)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
  await ensureCarContributionPolicy(c.env.DB);
  const policy=await c.env.DB.prepare('SELECT multiplier,enabled,updated_at FROM v5_car_contribution_policy WHERE id=1').first<any>();
  return c.json({ok:true,policy,car_attestation_available:false,live_reward_enabled:false});
});
router.post('/contribution-simulate',async c=>{
  const auth=await authUser(c);if(!auth)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
  await ensureCarContributionPolicy(c.env.DB);
  const b=await c.req.json().catch(()=>null) as any;
  if(!b||!Number.isSafeInteger(b.seconds)||b.seconds<1||b.seconds>86400)
    return c.json({ok:false,error:'INVALID_SECONDS'},400);
  const policy=await c.env.DB.prepare('SELECT multiplier,enabled FROM v5_car_contribution_policy WHERE id=1').first<any>();
  const multiplier=Number(policy?.multiplier||2.5);
  return c.json({ok:true,simulation:true,ledger_written:false,tlc_mined:0,
    assumed_vehicle_registered:true,assumed_bluetooth_connected:true,assumed_playback_verified:true,
    seconds:b.seconds,base_contribution:b.seconds,vehicle_multiplier:multiplier,
    weighted_contribution:Number((b.seconds*multiplier).toFixed(4)),
    live_reward_enabled:false});
});
router.put('/admin/contribution-policy',async c=>{
  const auth=await authUser(c);if(!auth)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
  const admin=await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(auth.id).first<any>();
  if(String(admin?.role||'').toLowerCase()!=='admin')return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const b=await c.req.json().catch(()=>null) as any;
  if(!b||typeof b.enabled!=='boolean'||typeof b.multiplier!=='number'||!Number.isFinite(b.multiplier)||b.multiplier<1||b.multiplier>5)
    return c.json({ok:false,error:'INVALID_POLICY'},400);
  await ensureCarContributionPolicy(c.env.DB);
  await c.env.DB.prepare('UPDATE v5_car_contribution_policy SET multiplier=?,enabled=?,updated_by=?,updated_at=? WHERE id=1')
    .bind(b.multiplier,b.enabled?1:0,auth.id,new Date().toISOString()).run();
  return c.json({ok:true,policy:{multiplier:b.multiplier,enabled:b.enabled},live_reward_enabled:false});
});

export default router;
