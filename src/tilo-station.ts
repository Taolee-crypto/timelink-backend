/**
 * Country-specific TILO station inventory.
 *
 * A public V5 SharePlace release is NOT a central-broadcast licence.
 * For every track the broadcaster service must be active, the copyright
 * holder must have an ACTIVE grant for this country, AND this exact service
 * must have an ACTIVE playback grant for that country and file.
 * Withdrawn/expired grants always win over a separate active row.
 */
export async function permittedStationTracks(db:D1Database,country:string,parentAdminId?:number) {
  return (await db.prepare(`SELECT DISTINCT v.file_id,v.duration_ms,f.title,f.artist
    FROM central_broadcast_service_accounts sa
    JOIN tl3_v5_releases v ON v.status='sealed'
    JOIN tl_files f ON f.id=v.file_id
    WHERE sa.status='active' AND (? IS NULL OR sa.parent_admin_user_id=?)
      AND f.shared=1 AND LOWER(f.file_type)='audio/tl3'
      AND COALESCE(f.revenue_held,0)=0
      AND v.duration_ms BETWEEN 1000 AND 3600000
      AND EXISTS(SELECT 1 FROM central_broadcast_rights_grants rg
        WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id
          AND rg.country=? AND rg.status='active'
          AND (rg.expires_at IS NULL OR julianday(rg.expires_at)>julianday('now')))
      AND NOT EXISTS(SELECT 1 FROM central_broadcast_rights_grants revoked
        WHERE revoked.file_id=v.file_id AND revoked.creator_id=v.user_id
          AND revoked.country=?
          AND (revoked.status<>'active' OR
            (revoked.expires_at IS NOT NULL AND julianday(revoked.expires_at)<=julianday('now'))))
      AND EXISTS(SELECT 1 FROM central_broadcast_service_file_grants sg
        WHERE sg.service_id=sa.service_id AND sg.file_id=v.file_id
          AND sg.country=? AND sg.status='active' AND sg.permission='stream'
          AND (sg.expires_at IS NULL OR julianday(sg.expires_at)>julianday('now')))
      AND NOT EXISTS(SELECT 1 FROM central_broadcast_service_file_grants stopped
        WHERE stopped.service_id=sa.service_id AND stopped.file_id=v.file_id
          AND stopped.country=?
          AND (stopped.status<>'active' OR
            (stopped.expires_at IS NOT NULL AND julianday(stopped.expires_at)<=julianday('now'))))
      AND EXISTS (SELECT 1 FROM tl_creator_metadata cm
        WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id
          AND cm.rights_declared=1
          AND cm.rights_role IN ('owner','authorized_agent','licensee')
          AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope')
          AND cm.declaration_status IN ('declared','verified','approved'))
    ORDER BY v.file_id ASC LIMIT 200`)
    .bind(parentAdminId??null,parentAdminId??null,country,country,country,country)
    .all<{file_id:number;duration_ms:number;title:string;artist:string}>()).results||[];
}
