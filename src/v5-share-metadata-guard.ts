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


/**
 * A sealed V5 release can update its DISPLAY metadata without changing the
 * music container, original creator split, beneficiary or money ledger.
 * Credits used for royalties are managed only through the verified contributor
 * workflow; passing identical values from the editor is backwards compatible.
 */
export class SealedV5MetadataError extends Error {
 constructor(public readonly code:string,public readonly fields:string[]=[]) {
  super(code);
 }
}
const V5_DISPLAY_FIELDS=['artist','album','producer','category','cover_url','lyrics'] as const;
const V5_RIGHTS_FIELDS=['composer','lyricist','arranger'] as const;
export function validateSealedV5MetadataPatch(
 body:Record<string,unknown>,
 canonicalRights:{composer:string,lyricist:string,arranger:string}
):Partial<Record<(typeof V5_DISPLAY_FIELDS)[number],string>> {
 const permitted=new Set<string>([...V5_DISPLAY_FIELDS,...V5_RIGHTS_FIELDS]);
 const unknown=Object.keys(body).filter(key=>!permitted.has(key));
 if(unknown.length)throw new SealedV5MetadataError('V5_METADATA_UNSUPPORTED_FIELDS',unknown);
 const requestedRights=V5_RIGHTS_FIELDS.filter(key=>
  body[key]!==undefined && (typeof body[key]!=='string' ||
  String(body[key]).trim()!==String(canonicalRights[key]||'').trim())
 );
 if(requestedRights.length)throw new SealedV5MetadataError('V5_RIGHTS_VERIFICATION_REQUIRED',[...requestedRights]);
 const limits:Record<string,number>={artist:200,album:200,producer:500,category:120,cover_url:2048,lyrics:20000};
 const cleaned:Partial<Record<(typeof V5_DISPLAY_FIELDS)[number],string>>={};
 const invalid:string[]=[];
 for(const key of V5_DISPLAY_FIELDS){
  if(body[key]===undefined)continue;
  if(typeof body[key]!=='string'||body[key].length>limits[key]){invalid.push(key);continue;}
  const value=key==='lyrics'?body[key]:(body[key] as string).trim();
  if(key==='category'&&!value){invalid.push(key);continue;}
  if(key==='cover_url'&&value&&!/^https:\/\//i.test(value)){invalid.push(key);continue;}
  cleaned[key]=value;
 }
 if(invalid.length)throw new SealedV5MetadataError('V5_METADATA_INVALID_FIELDS',invalid);
 return cleaned;
}
