import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();
router.use('*', async (c,next) => {
  const ready=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('v3_tracks','v3_track_metadata_versions','v3_track_assets','v3_track_releases','v3_shareplace_entries','v3_track_likes','v3_track_comments')").first<any>();
  if(Number(ready?.n||0)<7) return c.json({ok:false,code:'V3_PUBLIC_MUSIC_NOT_INITIALIZED',error:'V3 public music migration has not been applied'},503);
  await next();
});

async function publicTrack(db: D1Database, trackId: string) {
  return db.prepare(`
    SELECT t.id,u.username AS creator_name,t.created_at,
      m.display_title,
      COALESCE(m.verified_artist,m.extracted_artist) AS artist,
      m.verified_album,m.extracted_album,
      r.id AS release_id,r.duration_seconds,r.price_tl,
      
      (SELECT ca.storage_uri_ref FROM v3_track_assets ca
        WHERE ca.track_id=t.id AND ca.asset_type='cover_art'
          AND ca.availability_status='available' AND ca.storage_uri_ref IS NOT NULL
        ORDER BY ca.created_at DESC LIMIT 1) AS cover_url
    FROM v3_tracks t
    JOIN users u ON u.id=t.owner_user_id
    JOIN v3_shareplace_entries s ON s.track_id=t.id AND s.owner_user_id=t.owner_user_id AND s.visibility='public'
    JOIN v3_track_releases r ON r.track_id=t.id AND r.release_type='TL3' AND r.status='published'
    JOIN v3_track_assets a ON a.id=r.asset_id AND a.track_id=t.id
      AND a.asset_type='tl3_release_file' AND a.availability_status='available' 
    LEFT JOIN v3_track_metadata_versions m ON m.track_id=t.id
      AND m.version=(SELECT MAX(mx.version) FROM v3_track_metadata_versions mx WHERE mx.track_id=t.id)
    WHERE t.id=? AND t.status='active' AND t.visibility='public'
  `).bind(trackId).first<any>();
}

// Public catalogue exposes Track metadata and published TL3 products, never source MP3 bytes.
router.get('/tracks', async (c) => {
  const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') || 20)));
  const offset = Math.max(0, Number(c.req.query('offset') || 0));
  const rows = await c.env.DB.prepare(`
    SELECT t.id,u.username AS creator_name,
      m.display_title,COALESCE(m.verified_artist,m.extracted_artist) AS artist,
      r.id AS release_id,r.duration_seconds,r.price_tl,
      (SELECT ca.storage_uri_ref FROM v3_track_assets ca
        WHERE ca.track_id=t.id AND ca.asset_type='cover_art'
          AND ca.availability_status='available' AND ca.storage_uri_ref IS NOT NULL
        ORDER BY ca.created_at DESC LIMIT 1) AS cover_url,
      s.category,s.published_at,
      (SELECT COUNT(*) FROM v3_track_likes l WHERE l.track_id=t.id) AS likes_count,
      (SELECT COUNT(*) FROM v3_track_comments cm WHERE cm.track_id=t.id AND cm.moderation_status='visible') AS comments_count
    FROM v3_tracks t
    JOIN users u ON u.id=t.owner_user_id
    JOIN v3_shareplace_entries s ON s.track_id=t.id AND s.owner_user_id=t.owner_user_id AND s.visibility='public'
    JOIN v3_track_releases r ON r.track_id=t.id AND r.release_type='TL3' AND r.status='published'
    JOIN v3_track_assets a ON a.id=r.asset_id AND a.track_id=t.id
      AND a.asset_type='tl3_release_file' AND a.availability_status='available' 
    LEFT JOIN v3_track_metadata_versions m ON m.track_id=t.id
      AND m.version=(SELECT MAX(mx.version) FROM v3_track_metadata_versions mx WHERE mx.track_id=t.id)
    WHERE t.status='active' AND t.visibility='public'
    ORDER BY s.published_at DESC LIMIT ? OFFSET ?
  `).bind(limit,offset).all();
  return c.json({ ok:true, tracks:rows.results||[], limit, offset });
});

router.get('/tracks/:id', async (c) => {
  const track = await publicTrack(c.env.DB,c.req.param('id'));
  if (!track) return c.json({ ok:false,error:'Track not found' },404);
  const [releases,verified] = await Promise.all([
    c.env.DB.prepare("SELECT id,release_type,version,price_tl,duration_seconds,published_at FROM v3_track_releases WHERE track_id=? AND status='published' ORDER BY release_type").bind(track.id).all(),
    c.env.DB.prepare("SELECT 1 AS ok FROM v3_track_rights WHERE track_id=? AND verification_status='verified' LIMIT 1").bind(track.id).first()
  ]);
  return c.json({ ok:true,track,releases:releases.results||[],rights_verified:!!verified });
});

export default router;
