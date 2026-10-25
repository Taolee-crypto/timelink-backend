/** Spotify catalogue references only; never ownership evidence or audio imports. */
type Obj=Record<string,any>;
export class SpotifyCatalogueError extends Error {
 constructor(public status:number,message:string){super(message);}
}
const text=(v:unknown,max=500)=>typeof v==='string'?v.slice(0,max):'';
const list=(v:unknown)=>Array.isArray(v)?v:[];
export const validSpotifyId=(id:string)=>/^[A-Za-z0-9]{22}$/.test(id);
async function readObject(response:Response):Promise<Obj>{
 if(!response.ok){await response.body?.cancel();throw new SpotifyCatalogueError(response.status===429?429:502,'Spotify 조회 실패 (HTTP '+response.status+')');}
 const reader=response.body?.getReader();if(!reader)throw new SpotifyCatalogueError(502,'Spotify 응답이 비어 있습니다.');
 const chunks:Uint8Array[]=[];let total=0;
 try{while(true){const r=await reader.read();if(r.done)break;total+=r.value.byteLength;if(total>512000){await reader.cancel();throw new SpotifyCatalogueError(502,'Spotify 응답 크기 초과');}chunks.push(r.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
 const parsed=JSON.parse(new TextDecoder().decode(bytes));
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new SpotifyCatalogueError(502,'Spotify 응답 형식 오류');
 return parsed;
}
async function get(token:string,path:string){
 return readObject(await fetch('https://api.spotify.com/v1/'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000),redirect:'error'}));
}
export function mapSpotifyTrack(t:Obj){
 const album=t.album||{},artists=list(t.artists);
 return {id:text(t.id,64),title:text(t.name),artist:artists.map(a=>text(a.name,200)).join(', '),
  album:text(album.name),duration:typeof t.duration_ms==='number'?Math.round(t.duration_ms/1000):null,
  duration_ms:typeof t.duration_ms==='number'?t.duration_ms:null,
  isrc:text(t.external_ids?.isrc,32),external_ids:t.external_ids||{},
  cover_url:text(album.images?.[0]?.url),preview_url:text(t.preview_url),
  spotify_url:text(t.external_urls?.spotify),spotify_uri:text(t.uri),
  release_date:text(album.release_date,32),release_date_precision:text(album.release_date_precision,16),
  explicit:typeof t.explicit==='boolean'?t.explicit:null,
  disc_number:t.disc_number??null,track_number:t.track_number??null,
  album_id:text(album.id,64),album_type:text(album.album_type,32),total_tracks:album.total_tracks??null,
  artists:artists.map(a=>({id:text(a.id,64),name:text(a.name,200),url:text(a.external_urls?.spotify)})),
  images:list(album.images),available_markets:list(t.available_markets),is_playable:t.is_playable??null,
  restrictions:t.restrictions||null,popularity:t.popularity??null,linked_from:t.linked_from||null};
}
export async function searchSpotifyCatalogue(token:string,query:string){
 const q=query.trim().slice(0,200);if(!q)throw new SpotifyCatalogueError(400,'검색어가 필요합니다.');
 const url=q.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})(?:[/?#]|$)/);
 const uri=q.match(/^spotify:track:([A-Za-z0-9]{22})$/);
 const direct=url?.[1]||uri?.[1];
 if(direct)return [mapSpotifyTrack(await get(token,'tracks/'+direct+'?market=KR'))];
 const d=await get(token,'search?q='+encodeURIComponent(q)+'&type=track&limit=6&market=KR');
 return list(d.tracks?.items).map(mapSpotifyTrack);
}
async function ensureCache(db:D1Database){
 await db.prepare(`CREATE TABLE IF NOT EXISTS spotify_catalogue_cache(track_id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL,fetched_at TEXT NOT NULL)`).run();
}
export async function spotifyCatalogueDetails(db:D1Database,token:()=>Promise<string>,id:string){
 if(!validSpotifyId(id))throw new SpotifyCatalogueError(400,'Spotify Track ID 형식이 올바르지 않습니다.');
 await ensureCache(db);
 const cached=await db.prepare("SELECT metadata_json FROM spotify_catalogue_cache WHERE track_id=? AND julianday(fetched_at)>julianday('now','-1 day')").bind(id).first<{metadata_json:string}>();
 if(cached){try{return JSON.parse(cached.metadata_json) as Obj;}catch{/* refresh corrupt reference */}}
 const access=await token();const track=await get(access,'tracks/'+id+'?market=KR');
 if(track.id!==id&&!track.linked_from?.id)throw new SpotifyCatalogueError(502,'Spotify 곡 식별자가 일치하지 않습니다.');
 const unavailable:string[]=[];
 const optional=async(path:string,name:string)=>{try{return await get(access,path);}catch{unavailable.push(name);return null;}};
 const artistIds=[...new Set(list(track.artists).map(a=>String(a.id||'')).filter(validSpotifyId))].slice(0,8);
 const [fullAlbum,...fullArtists]=await Promise.all([
  validSpotifyId(String(track.album?.id||''))?optional('albums/'+track.album.id+'?market=KR','album'):Promise.resolve(null),
  ...artistIds.map(a=>optional('artists/'+a,'artist:'+a))
 ]);
 const album=fullAlbum||track.album||{};
 const {tracks:otherAlbumTracks,...albumMetadata}=album;
 const artists=fullArtists.filter(Boolean);
 const genres=[...new Set([...list(album.genres),...artists.flatMap(a=>list(a!.genres))].filter(x=>typeof x==='string'))];
 const result={...mapSpotifyTrack({...track,album}),requested_id:id,
  upc:text(album.external_ids?.upc,32),ean:text(album.external_ids?.ean,32),label:text(album.label),
  copyrights:list(album.copyrights),genres,
  catalogue:{source:'spotify',retrieved_at:new Date().toISOString(),rights_verified:false,
   track,album:albumMetadata,artists,unavailable},
  rights_verified:false};
 await db.prepare('INSERT INTO spotify_catalogue_cache(track_id,metadata_json,fetched_at) VALUES(?,?,?) ON CONFLICT(track_id) DO UPDATE SET metadata_json=excluded.metadata_json,fetched_at=excluded.fetched_at')
  .bind(id,JSON.stringify(result),result.catalogue.retrieved_at).run();
 return result;
}
export async function storeCreatorSpotifyReference(db:D1Database,fileId:number,userId:number,metadata:Obj|null){
 await db.prepare(`CREATE TABLE IF NOT EXISTS tl_creator_spotify_metadata(file_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,spotify_track_id TEXT NOT NULL,isrc TEXT,metadata_json TEXT NOT NULL,fetched_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')))`).run();
 if(!metadata){await db.prepare('DELETE FROM tl_creator_spotify_metadata WHERE file_id=? AND user_id=?').bind(fileId,userId).run();return;}
 await db.prepare(`INSERT INTO tl_creator_spotify_metadata(file_id,user_id,spotify_track_id,isrc,metadata_json,fetched_at) VALUES(?,?,?,?,?,?)
  ON CONFLICT(file_id) DO UPDATE SET spotify_track_id=excluded.spotify_track_id,isrc=excluded.isrc,metadata_json=excluded.metadata_json,fetched_at=excluded.fetched_at,updated_at=datetime('now') WHERE tl_creator_spotify_metadata.user_id=excluded.user_id`)
  .bind(fileId,userId,metadata.requested_id||metadata.id,metadata.isrc||null,JSON.stringify(metadata),metadata.catalogue.retrieved_at).run();
}
