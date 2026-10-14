import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
router.use('*', authMiddleware);
router.use('*', async (c, next) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(user.id).first<{ role: string }>();
  if (String(row?.role || '').toLowerCase() !== 'admin') {
    return c.json({ ok: false, error: 'Administrator role required' }, 403);
  }
  const ready = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('v3_tracks','v3_rights_review_events','v3_release_review_events')"
  ).first<{ n: number }>();
  if (Number(ready?.n || 0) < 3) {
    return c.json({ ok: false, code: 'V3_REVIEW_NOT_INITIALIZED', error: 'V3 review audit migration has not been applied' }, 503);
  }
  await next();
});

const id = () => crypto.randomUUID();
const note = (v: unknown) => String(v || '').trim().slice(0, 2000);

// GET /queue — admin-only release review queue
router.get('/queue', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT r.id AS release_id,r.track_id,r.release_type,r.version,r.status,r.price_tl,r.created_at,
      t.owner_user_id,m.display_title,m.verified_artist,m.extracted_artist,
      a.asset_type,a.storage_provider,a.availability_status,
      (SELECT COUNT(*) FROM v3_track_rights x WHERE x.track_id=t.id AND x.verification_status='verified') AS verified_rights_count
    FROM v3_track_releases r
    JOIN v3_tracks t ON t.id=r.track_id
    LEFT JOIN v3_track_metadata_versions m ON m.track_id=t.id
      AND m.version=(SELECT MAX(mx.version) FROM v3_track_metadata_versions mx WHERE mx.track_id=t.id)
    LEFT JOIN v3_track_assets a ON a.id=r.asset_id
    WHERE r.status='ready_for_review'
    ORDER BY r.created_at ASC LIMIT 100
  `).all();
  return c.json({ ok: true, queue: rows.results || [] });
});

// GET /releases/:releaseId — review detail, including declarations and evidence references
router.get('/releases/:releaseId', async (c) => {
  const releaseId = c.req.param('releaseId');
  const release = await c.env.DB.prepare(`
    SELECT r.*,t.owner_user_id,t.status AS track_status,t.visibility,
      m.display_title,m.extracted_title,m.extracted_artist,m.extracted_album
    FROM v3_track_releases r JOIN v3_tracks t ON t.id=r.track_id
    LEFT JOIN v3_track_metadata_versions m ON m.track_id=t.id
      AND m.version=(SELECT MAX(mx.version) FROM v3_track_metadata_versions mx WHERE mx.track_id=t.id)
    WHERE r.id=?
  `).bind(releaseId).first<any>();
  if (!release) return c.json({ ok: false, error: 'Release not found' }, 404);
  const [rights, asset, history, rightsHistory] = await Promise.all([
    c.env.DB.prepare('SELECT id,claimant_user_id,rights_role,ownership_share_bps,territory,evidence_ref,verification_status,terms_version,attested_at,created_at FROM v3_track_rights WHERE track_id=? ORDER BY created_at').bind(release.track_id).all(),
    c.env.DB.prepare('SELECT id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status FROM v3_track_assets WHERE id=?').bind(release.asset_id).first(),
    c.env.DB.prepare('SELECT decision,review_note,reviewer_user_id,created_at FROM v3_release_review_events WHERE release_id=? ORDER BY created_at DESC').bind(releaseId).all(),
    c.env.DB.prepare('SELECT decision,review_note,reviewer_user_id,created_at FROM v3_rights_review_events WHERE track_id=? ORDER BY created_at DESC').bind(release.track_id).all()
  ]);
  return c.json({ ok: true, release, rights: rights.results || [], asset: asset || null, review_history: history.results || [], rights_review_history: rightsHistory.results || [] });
});

// POST /rights/:rightsId/decision — explicit human verification/rejection with immutable audit event
router.post('/rights/:rightsId/decision', async (c) => {
  const rightsId = c.req.param('rightsId');
  let body: any; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const decision = String(body.decision || '');
  if (decision !== 'verified' && decision !== 'rejected') return c.json({ ok: false, error: 'decision must be verified or rejected' }, 422);
  const reviewNote = note(body.review_note);
  if (!reviewNote) return c.json({ ok: false, error: 'A review_note is required for the audit trail' }, 422);
  const claim = await c.env.DB.prepare("SELECT id,track_id,verification_status,attested_at,terms_version FROM v3_track_rights WHERE id=?").bind(rightsId).first<any>();
  if (!claim) return c.json({ ok: false, error: 'Rights declaration not found' }, 404);
  if (!claim.attested_at || !claim.terms_version) return c.json({ ok: false, error: 'Rights declaration has no valid attestation record' }, 422);
  if (claim.verification_status === 'verified' || claim.verification_status === 'rejected') return c.json({ ok: false, error: 'Rights declaration has already received a final decision' }, 409);
  const eventId = id(), reviewer = c.get('user');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE v3_track_rights SET verification_status=?,updated_at=datetime(\'now\') WHERE id=? AND verification_status IN (\'declared\',\'pending\')').bind(decision, rightsId),
    c.env.DB.prepare('INSERT INTO v3_rights_review_events(id,rights_id,track_id,reviewer_user_id,decision,review_note) VALUES(?,?,?,?,?,?)').bind(eventId,rightsId,claim.track_id,reviewer.id,decision,reviewNote)
  ]);
  return c.json({ ok: true, rights_id: rightsId, decision, review_event_id: eventId });
});

// POST /releases/:releaseId/approve — trigger-enforced verified rights + available matching asset
router.post('/releases/:releaseId/approve', async (c) => {
  const releaseId = c.req.param('releaseId');
  let body: any; try { body = await c.req.json(); } catch { body = {}; }
  const reviewNote = note(body.review_note);
  if (!reviewNote) return c.json({ ok: false, error: 'A review_note is required for the audit trail' }, 422);
  const release = await c.env.DB.prepare("SELECT id,track_id,status FROM v3_track_releases WHERE id=?").bind(releaseId).first<any>();
  if (!release) return c.json({ ok: false, error: 'Release not found' }, 404);
  if (release.status !== 'ready_for_review') return c.json({ ok: false, error: 'Only releases awaiting review can be approved' }, 409);
  const reviewer = c.get('user'), eventId = id();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE v3_track_releases SET status='published',published_at=datetime('now'),updated_at=datetime('now'),rights_snapshot_json=json_object('captured_at',datetime('now'),'rights',json((SELECT json_group_array(json_object('id',x.id,'claimant_user_id',x.claimant_user_id,'rights_role',x.rights_role,'ownership_share_bps',x.ownership_share_bps,'territory',x.territory,'verification_status',x.verification_status,'terms_version',x.terms_version,'attested_at',x.attested_at)) FROM v3_track_rights x WHERE x.track_id=v3_track_releases.track_id))) WHERE id=? AND status='ready_for_review'").bind(releaseId),
      c.env.DB.prepare("UPDATE v3_tracks SET status='active',visibility='public',updated_at=datetime('now') WHERE id=? AND EXISTS(SELECT 1 FROM v3_track_releases WHERE id=? AND status='published')").bind(release.track_id,releaseId),
      c.env.DB.prepare("INSERT INTO v3_shareplace_entries(id,track_id,owner_user_id,category,visibility,published_at) SELECT ?,t.id,t.owner_user_id,'Music','public',datetime('now') FROM v3_tracks t WHERE t.id=? AND EXISTS(SELECT 1 FROM v3_track_releases WHERE id=? AND status='published') ON CONFLICT(track_id) DO UPDATE SET visibility='public',published_at=datetime('now'),updated_at=datetime('now')").bind(id(),release.track_id,releaseId),
      c.env.DB.prepare("INSERT INTO v3_release_review_events(id,release_id,track_id,reviewer_user_id,decision,review_note) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM v3_track_releases WHERE id=? AND status='published')").bind(eventId,releaseId,release.track_id,reviewer.id,'approved',reviewNote,releaseId)
    ]);
    if (Number(results[0]?.meta?.changes || 0) !== 1) return c.json({ ok: false, error: 'Release was not approved; verify rights and asset availability' }, 422);
  } catch (e: any) {
    return c.json({ ok: false, error: 'Approval blocked by release integrity checks: ' + String(e?.message || 'validation failed').slice(0, 300) }, 422);
  }
  return c.json({ ok: true, release_id: releaseId, status: 'published', shareplace_visibility: 'public' });
});

// POST /releases/:releaseId/reject — reject a pending release without publishing
router.post('/releases/:releaseId/reject', async (c) => {
  const releaseId = c.req.param('releaseId');
  let body: any; try { body = await c.req.json(); } catch { body = {}; }
  const reviewNote = note(body.review_note);
  if (!reviewNote) return c.json({ ok: false, error: 'A review_note is required for the audit trail' }, 422);
  const release = await c.env.DB.prepare("SELECT id,track_id,status FROM v3_track_releases WHERE id=?").bind(releaseId).first<any>();
  if (!release) return c.json({ ok: false, error: 'Release not found' }, 404);
  if (release.status !== 'ready_for_review') return c.json({ ok: false, error: 'Only releases awaiting review can be rejected' }, 409);
  const reviewer = c.get('user'), eventId = id();
  const result = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE v3_track_releases SET status='suspended',updated_at=datetime('now') WHERE id=? AND status='ready_for_review'").bind(releaseId),
    c.env.DB.prepare("INSERT INTO v3_release_review_events(id,release_id,track_id,reviewer_user_id,decision,review_note) VALUES(?,?,?,?, 'rejected',?)").bind(eventId,releaseId,release.track_id,reviewer.id,reviewNote)
  ]);
  if (Number(result[0]?.meta?.changes || 0) !== 1) return c.json({ ok: false, error: 'Release state changed; reload the queue' }, 409);
  return c.json({ ok: true, release_id: releaseId, status: 'suspended' });
});

export default router;
