import { Hono } from 'hono';
import type { Env } from '../types';
import { calculateCentralBroadcastAtoms } from '../central-broadcast-v5-settlement';

const router = new Hono<{ Bindings: Env }>();
type Song = {file_id:number;share_id:string;title:string;artist:string;genre:string;duration_ms:number;creator_id:number};
/**
 * Only V5 sealed, published, rights-confirmed tracks enter the broadcast
 * planning inventory. This is NOT a public audio download or license endpoint.
 */
router.get('/inventory', async c => {
  try {
    const rows=await c.env.DB.prepare(`
      SELECT v.file_id,v.share_id,v.duration_ms,v.user_id AS creator_id,
        f.title,f.artist,f.genre
      FROM tl3_v5_releases v
      JOIN tl_files f ON f.id=v.file_id
      WHERE v.status='sealed' AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0
        AND LOWER(f.file_type)='audio/tl3'
        AND EXISTS (SELECT 1 FROM tl3_releases r
          WHERE r.file_id=v.file_id AND r.status='released' AND r.rights_confirmed=1)
      ORDER BY v.file_id DESC LIMIT 500
    `).all<Song>();
    const tracks=(rows.results||[]).filter(s=>Number.isSafeInteger(s.file_id)&&s.duration_ms>0);
    return c.json({ok:true,tracks,requires_broadcast_license:true,
      note:'Rights confirmation for SharePlace does not itself grant central broadcast rights.'});
  } catch(e:any){return c.json({ok:false,error:'BROADCAST_INVENTORY_UNAVAILABLE'},503)}
});
/** Read-only calculation: never accepts a browser event as proof of airtime. */
router.get('/settlement-preview', c => {
  const raw=c.req.query('played_ms')||'';
  if(!/^\d{1,12}$/.test(raw))return c.json({ok:false,error:'Invalid played_ms'},400);
  const ms=BigInt(raw);
  if(ms>86400000n)return c.json({ok:false,error:'Preview limited to 24 hours'},400);
  const r=calculateCentralBroadcastAtoms(ms);
  return c.json({ok:true,played_ms:Number(ms),weight:0.3,creator_share:0.7,platform_share:0.3,
    total_atoms:Number(r.totalAtoms),creator_atoms:Number(r.creatorAtoms),
    platform_atoms:Number(r.platformAtoms),atoms_per_tl:10000,posted:false});
});
export default router;
