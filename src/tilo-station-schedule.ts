import { permittedStationTracks } from './tilo-station';
import { planTiloBroadcast } from './tilo-v5-scheduler';

/** Payment changes priority only. Both pools come from the same public,
 * rights-declared V5 inventory. The day/country seed keeps receivers in sync. */
export async function scheduledStationTracks(db:D1Database,country:string,now:Date) {
  const tracks=await permittedStationTracks(db,country);
  if(!tracks.length)return tracks;
  let orders: {file_id:number}[]=[];
  try {
    orders=(await db.prepare(`SELECT DISTINCT CAST(j.value AS INTEGER) AS file_id
      FROM v5_premium_orders o JOIN json_each(o.file_ids_json) j
      JOIN tl3_v5_releases v ON v.file_id=CAST(j.value AS INTEGER) AND v.user_id=o.user_id
      JOIN v3_economy_accounts a ON a.owner_type='escrow' AND a.owner_id=o.order_id
        AND a.asset_code='TL' AND a.bucket='premium_budget' AND a.status='active'
      JOIN v3_economy_balances b ON b.account_id=a.id AND b.available_atoms>0
      WHERE o.method='tl' AND o.status='funded_pending_broadcast'`).all<{file_id:number}>()).results||[];
  } catch(e) {
    // A station with no premium schema must still play ordinary tracks.
    if(!/no such table.*v5_premium_orders/i.test(String(e)))throw e;
  }
  const promoted=new Set(orders.map(o=>Number(o.file_id)));
  let seed=2166136261;
  for(const c of country+now.toISOString().slice(0,10))seed=Math.imul(seed^c.charCodeAt(0),16777619)>>>0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const plan=planTiloBroadcast(tracks.map(t=>({fileId:t.file_id,artist:t.artist,
    durationMs:t.duration_ms,eligiblePromotion:promoted.has(t.file_id),campaignId:promoted.has(t.file_id)?t.file_id:null})),
    {promotedMs:0,ordinaryMs:0},Math.min(86400000,tracks.reduce((n,t)=>n+t.duration_ms,0)),[],[],random);
  const byId=new Map(tracks.map(t=>[t.file_id,t]));
  return plan.selections.map(s=>({...byId.get(s.track.fileId)!,is_promoted:s.kind==='promoted'}));
}
