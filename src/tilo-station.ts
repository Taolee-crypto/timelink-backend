/** A public station uses platform service grants, never the listener's identity
 * as an administrator. Every license request rechecks these same conditions. */
export async function permittedStationTracks(db:D1Database,country:string,parentAdminId?:number) {
  return (await db.prepare(`SELECT DISTINCT v.file_id,v.duration_ms,f.title,f.artist
    FROM central_broadcast_service_accounts sa
    JOIN central_broadcast_service_file_grants sg ON sg.service_id=sa.service_id
    JOIN tl3_v5_releases v ON v.file_id=sg.file_id
    JOIN tl_files f ON f.id=v.file_id
    WHERE sa.status='active' AND (? IS NULL OR sa.parent_admin_user_id=?)
      AND sg.country=? AND sg.status='active'
      AND (sg.expires_at IS NULL OR julianday(sg.expires_at)>julianday('now'))
      AND v.status='sealed' AND f.shared=1 AND LOWER(f.file_type)='audio/tl3'
      AND COALESCE(f.revenue_held,0)=0
      AND EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=sg.country
          AND rg.status='active' AND (rg.expires_at IS NULL OR julianday(rg.expires_at)>julianday('now')))
      AND EXISTS(SELECT 1 FROM tl3_releases r WHERE r.file_id=v.file_id
        AND r.status='released' AND r.rights_confirmed=1)
    ORDER BY v.file_id ASC LIMIT 200`).bind(parentAdminId??null,parentAdminId??null,country)
    .all<{file_id:number;duration_ms:number;title:string;artist:string}>()).results||[];
}
