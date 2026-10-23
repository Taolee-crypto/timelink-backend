/** Idempotent D1 schema bootstrap; creates tables only, never grants rights. */
export async function ensureCentralBroadcastSchema(db:D1Database):Promise<void>{
  await db.prepare(`CREATE TABLE IF NOT EXISTS central_broadcast_service_accounts (
    service_id TEXT PRIMARY KEY, parent_admin_user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'disabled',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS central_broadcast_rights_grants (
    grant_id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, creator_id INTEGER NOT NULL,
    country TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'inactive',
    expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS central_broadcast_service_file_grants (
    service_id TEXT NOT NULL, file_id INTEGER NOT NULL, country TEXT NOT NULL,
    permission TEXT NOT NULL DEFAULT 'stream', status TEXT NOT NULL DEFAULT 'disabled',
    expires_at TEXT, granted_by_admin_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(service_id,file_id,country))`).run();
}
