/**
 * Fields that define ownership, rights clearance, billing or sealed TL3
 * identity are NEVER changed using an ordinary creator metadata PATCH.
 * Editing artist, lyrics, artwork, description etc. remains supported.
 */
export const IMMUTABLE_SHARE_FIELDS=Object.freeze([
 'id','title','user_id','username',
 'release_mode','content_kind','stream_url','file_type','file_tl',
 'price_per_sec','storage_mode','origin_hash','release_check',
 'shared','auth_status','rights_confirmed','revenue_held',
 'pulse','play_count','created_at','updated_at','duration','duration_ms',
 'duration_seconds','plan','is_active','deleted','owner_id','cert_no',
] as const);

export function rejectedImmutableShareFields(body:unknown):string[]{
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_SHARE_PATCH');
 const fields=new Set<string>(IMMUTABLE_SHARE_FIELDS);
 return Object.keys(body).filter(key=>fields.has(key));
}
