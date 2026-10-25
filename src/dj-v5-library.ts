/** One V5 eligibility rule for the DJ library, sets and monitor licensing. */
export type DjTrack = {id:string;file_id:number;title:string;artist:string;category:string;duration:number;
  duration_ms:number;cover_url:string;content_kind:string;version:number;stream_url:string;user_id:number;is_promoted?:boolean};
export const DJ_TRACK_SQL = `SELECT v.share_id AS id,v.file_id,v.user_id,f.title,f.artist,f.genre AS category,
  v.duration_ms,CAST(v.duration_ms/1000 AS INTEGER) AS duration,COALESCE(f.cover_image,'') AS cover_url,
  'tl3' AS content_kind,5 AS version,f.stream_url
  FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id
  WHERE v.status='sealed' AND f.shared=1 AND LOWER(f.file_type)='audio/tl3'
  AND COALESCE(f.revenue_held,0)=0 AND v.duration_ms>0
  AND EXISTS(SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id
    AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee')
    AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope')
    AND cm.declaration_status IN ('declared','verified','approved'))`;
export async function djTrack(db:D1Database,id:string):Promise<DjTrack|null>{
  const rows=(await db.prepare(DJ_TRACK_SQL+` AND (CAST(v.share_id AS TEXT)=? OR EXISTS(
    SELECT 1 FROM tl_shares s WHERE CAST(s.id AS TEXT)=? AND s.stream_url=f.stream_url AND s.user_id=v.user_id))
    LIMIT 2`).bind(id,id).all<DjTrack>()).results||[];
  return rows.length===1?rows[0]:null;
}
export async function djLibrary(db:D1Database,userId?:number):Promise<DjTrack[]>{
  const query=DJ_TRACK_SQL+(userId?' AND v.user_id=?':'')+' ORDER BY v.file_id DESC LIMIT 1000';
  const statement=db.prepare(query);
  const tracks=(await (userId?statement.bind(userId):statement).all<DjTrack>()).results||[];
  let promoted:number[]=[];
  try{
    const rows=await db.prepare(`SELECT DISTINCT CAST(j.value AS INTEGER) AS file_id
      FROM v5_premium_orders o JOIN json_each(o.file_ids_json) j
      JOIN tl3_v5_releases v ON v.file_id=CAST(j.value AS INTEGER) AND v.user_id=o.user_id
      JOIN v3_economy_accounts a ON a.owner_type='escrow' AND a.owner_id=o.order_id
        AND a.asset_code='TL' AND a.bucket='premium_budget' AND a.status='active'
      JOIN v3_economy_balances b ON b.account_id=a.id AND b.available_atoms>0
      WHERE o.method='tl' AND o.status='funded_pending_broadcast'`).all<{file_id:number}>();
    promoted=(rows.results||[]).map(r=>Number(r.file_id));
  }catch(error){if(!/no such table.*(v5_premium_orders|v3_economy_accounts|v3_economy_balances)/i.test(String(error)))throw error;}
  const paid=new Set(promoted);
  return tracks.map(t=>({...t,is_promoted:paid.has(t.file_id)})).sort((a,b)=>Number(b.is_promoted)-Number(a.is_promoted)||b.file_id-a.file_id);
}
/** Free monitor access is limited to the owner, current live station and exact current V5 track.
 * It never grants a listener discount or creates airtime/reward evidence. */
export async function authorizeDjMonitor(db:D1Database,userId:number,stationId:number,fileId:number):Promise<boolean>{
  if(!Number.isSafeInteger(stationId)||stationId<=0)return false;
  const station=await db.prepare("SELECT live_current_track_id FROM dj_profiles WHERE id=? AND user_id=? AND status='active' AND is_live=1")
    .bind(stationId,userId).first<{live_current_track_id:string}>();
  if(!station)return false;
  const track=await djTrack(db,String(station.live_current_track_id||''));
  return !!track&&Number(track.file_id)===fileId;
}
