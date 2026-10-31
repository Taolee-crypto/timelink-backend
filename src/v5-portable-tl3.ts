const te=new TextEncoder();
const MAGIC=te.encode('TLP5CAP1');

function bytes(value:Uint8Array):ArrayBuffer{
  return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength) as ArrayBuffer;
}
function concat(...parts:Uint8Array[]):Uint8Array{
  const out=new Uint8Array(parts.reduce((n,p)=>n+p.byteLength,0));let o=0;
  for(const p of parts){out.set(p,o);o+=p.byteLength;}return out;
}
function u32(value:number):Uint8Array{
  return new Uint8Array([(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255]);
}
function b64u(value:Uint8Array):string{
  let raw='';for(let i=0;i<value.length;i+=0x8000)raw+=String.fromCharCode(...value.subarray(i,i+0x8000));
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function hex(value:Uint8Array):string{return Array.from(value).map(x=>x.toString(16).padStart(2,'0')).join('');}
async function digest(value:Uint8Array):Promise<Uint8Array>{return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(value)));}

export type PortableTl3Capsule={
  kind:'timelink-portable-playback';
  version:1;
  grant_id:string;
  file_id:number;
  share_id:string;
  base_sha256:string;
  file_signal:string;
  reserved_seconds:number;
  nonce:string;
  wrapped_content_key:string;
};

export async function inspectV5Base(base:Uint8Array){
  if(base.byteLength<32||base[0]!==0x54||base[1]!==0x4c||base[2]!==0x4e||base[3]!==0x4b||base[4]!==5)
    throw new Error('PORTABLE_TL3_BASE_INVALID');
  const headerLength=((base[5]<<24)|(base[6]<<16)|(base[7]<<8)|base[8])>>>0;
  const end=9+headerLength;
  if(headerLength<2||headerLength>65536||end+16>base.byteLength)throw new Error('PORTABLE_TL3_HEADER_INVALID');
  let header:any;try{header=JSON.parse(new TextDecoder().decode(base.slice(9,end)));}catch{throw new Error('PORTABLE_TL3_HEADER_INVALID');}
  if(header?.profile!=='TL3-V5'||header?.algorithm!=='AES-256-GCM'||Number(header?.ciphertext_bytes)!==base.byteLength-end)
    throw new Error('PORTABLE_TL3_BOOTSTRAP_INVALID');
  const baseSha=hex(await digest(base));
  const prefixDigest=await digest(base.slice(0,end));
  const embedded=header?.love_code?.version===1&&typeof header?.love_code?.file_signal==='string'&&
    /^[A-Za-z0-9_-]{24,96}$/.test(header.love_code.file_signal)?header.love_code.file_signal:null;
  const fileSignal=embedded||b64u(prefixDigest);
  return {header,headerEnd:end,baseSha,fileSignal};
}

function portableAad(c:Pick<PortableTl3Capsule,'grant_id'|'file_id'|'share_id'|'base_sha256'|'file_signal'|'reserved_seconds'>){
  return ['timelink:tl3:v5:portable:v1',c.grant_id,c.file_id,c.share_id,c.base_sha256,c.file_signal,c.reserved_seconds].join(':');
}

export async function buildPortableCapsule(base:Uint8Array,contentKey:Uint8Array,input:{
  grantId:string;fileId:number;shareId:string;reservedSeconds:number;
}):Promise<PortableTl3Capsule>{
  if(contentKey.byteLength!==32)throw new Error('PORTABLE_TL3_KEY_INVALID');
  if(!/^[A-Za-z0-9_-]{12,128}$/.test(input.grantId)||!Number.isSafeInteger(input.fileId)||input.fileId<=0||
     !input.shareId||!Number.isSafeInteger(input.reservedSeconds)||input.reservedSeconds<=0)
    throw new Error('PORTABLE_TL3_GRANT_INVALID');
  const info=await inspectV5Base(base);
  const seed=await digest(te.encode(['timelink:tl3:v5:portable-wrap:v1',info.fileSignal,input.grantId,info.baseSha].join(':')));
  const key=await crypto.subtle.importKey('raw',bytes(seed),{name:'AES-GCM'},false,['encrypt']);
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const draft={
    kind:'timelink-portable-playback' as const,version:1 as const,
    grant_id:input.grantId,file_id:input.fileId,share_id:input.shareId,
    base_sha256:info.baseSha,file_signal:info.fileSignal,reserved_seconds:input.reservedSeconds
  };
  const wrapped=new Uint8Array(await crypto.subtle.encrypt(
    {name:'AES-GCM',iv:bytes(nonce),additionalData:te.encode(portableAad(draft)),tagLength:128},
    key,bytes(contentKey)
  ));
  return {...draft,nonce:b64u(nonce),wrapped_content_key:b64u(wrapped)};
}

export function appendPortableCapsule(base:Uint8Array,capsule:PortableTl3Capsule):Uint8Array{
  const payload=te.encode(JSON.stringify(capsule));
  if(payload.byteLength>65536)throw new Error('PORTABLE_TL3_CAPSULE_TOO_LARGE');
  return concat(base,payload,u32(payload.byteLength),MAGIC);
}
