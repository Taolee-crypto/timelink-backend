/**
 * Canonical identity for comments and likes. Legacy tl_shares and sealed
 * TL3 V5 releases can coexist, but may not expose an unpublished asset.
 * Do not use this helper for audio authorisation, royalty calculation or billing.
 */
export interface SocialTrackAsset {
 id:string;
 ownerId:number;
 canView:boolean;
 kind:'legacy'|'v5';
}
export async function resolveSocialTrackAsset(
 db:any,requestedId:string,viewerId:number,
 legacyIsPublic:(share:any)=>Promise<boolean>
):Promise<SocialTrackAsset|null>{
 const id=String(requestedId||'').trim();
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return null;
 const findV5=async():Promise<SocialTrackAsset|null>=>{
  const v5=await db.prepare(`SELECT v.share_id,v.user_id,f.shared
    FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id
    WHERE (v.share_id=? OR CAST(v.file_id AS TEXT)=?
      OR ('tl3_'||CAST(v.file_id AS TEXT))=?)
      AND v.status='sealed' AND LOWER(f.file_type)='audio/tl3' LIMIT 1`)
    .bind(id,id,id).first();
  if(!v5)return null;
  const ownerId=Number(v5.user_id||0);
  return {id:String(v5.share_id),ownerId,canView:viewerId>0&&ownerId===viewerId||Number(v5.shared)===1,kind:'v5'};
 };
 // Explicit tl3_<file_id> always means a sealed release, not a possible
 // numeric legacy share with the same file ID.
 if(/^tl3_\d+$/.test(id)){
  return findV5();
 }
 const legacy=await db.prepare('SELECT * FROM tl_shares WHERE id=?').bind(id).first();
 if(legacy){
  const ownerId=Number(legacy.user_id||0);
  const canView=(viewerId>0&&ownerId===viewerId)||await legacyIsPublic(legacy);
  return {id:String(legacy.id),ownerId,canView,kind:'legacy'};
 }
 return findV5();
}
