import type {Env} from './types';
import {getTrackPoolBalances,ensureLedgerAccount,postLedgerTransaction,TL_ATOMS_PER_TL,assertTLAtomScale} from './economy-ledger';
import {reserveOfflineV5TrackTl} from './v5-offline-ledger-reservation';
import {validateOfflineV5Settlement} from './v5-offline-settlement-contract';
import {readCreatorSplit,allocateCreatorAtoms} from './creator-split-policy';
import {CREATOR_SHARE_RATE} from './economy-policy';
import {unwrapAssetKey,resolveMasterKeyring} from './routes/tl3-v5';

const encoder=new TextEncoder();
const toB64=(u:Uint8Array)=>btoa(Array.from(u,x=>String.fromCharCode(x)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
const fromB64=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const binary=(u:Uint8Array)=>u.buffer.slice(u.byteOffset,u.byteOffset+u.byteLength) as ArrayBuffer;
const validId=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{16,96}$/.test(s);
const validSha=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const sigKey=(env:Env)=>String(env.TL3_OFFLINE_SIGNING_PRIVATE_KEY||'');
const pubKey=(env:Env)=>String(env.TL3_OFFLINE_SIGNING_PUBLIC_KEY||'');
const p256=(value:any)=>value?.kty==='EC'&&value?.crv==='P-256'&&/^[A-Za-z0-9_-]{43}$/.test(String(value.x||''))&&/^[A-Za-z0-9_-]{43}$/.test(String(value.y||''))&&!('d' in value);
async function getSignKeys(env:Env){
 const privateDer=sigKey(env),publicDer=pubKey(env);
 if(!privateDer||!publicDer)throw Error('OFFLINE_SIGNING_KEYS_NOT_CONFIGURED');
 const privateKey=await crypto.subtle.importKey('pkcs8',binary(fromB64(privateDer)),'Ed25519',false,['sign']);
 const publicKey=await crypto.subtle.importKey('spki',binary(fromB64(publicDer)),'Ed25519',false,['verify']);
 return {privateKey,publicKey,publicDer};
}
export async function ensureOfflineV5Table(db:D1Database){
 await db.prepare('CREATE TABLE IF NOT EXISTS tl3_v5_offline_entitlements ('+
 'entitlement_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,player_id TEXT NOT NULL,'+
 'file_id INTEGER NOT NULL,share_id TEXT NOT NULL,container_sha256 TEXT NOT NULL,'+
 'reserved_seconds INTEGER NOT NULL,expires_at INTEGER NOT NULL,'+
 'source_atoms_json TEXT NOT NULL,grant_json TEXT NOT NULL,license_json TEXT NOT NULL,'+
 "status TEXT NOT NULL DEFAULT 'issued',settled_seconds INTEGER,settlement_hash TEXT,"+
 "created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
 await db.prepare('CREATE INDEX IF NOT EXISTS idx_tl3_offline_user ON tl3_v5_offline_entitlements(user_id,status)').run();
}
function exportPayload(row:any){return {ok:true,entitlement_id:row.entitlement_id,file_id:row.file_id,share_id:row.share_id,expires_at:row.expires_at,grant:JSON.parse(row.grant_json),license:JSON.parse(row.license_json),signing_public_key:row.signing_public_key};}
async function sealForDevice(publicJwk:any,contentKey:Uint8Array,userId:number,playerId:string,entitlementId:string,sha:string){
 if(!p256(publicJwk))throw Error('OFFLINE_DEVICE_KEY_INVALID');
 const member=await crypto.subtle.importKey('jwk',publicJwk,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const temp=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']) as CryptoKeyPair;
 const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:member},temp.privateKey,256));
 const salt=crypto.getRandomValues(new Uint8Array(32)),nonce=crypto.getRandomValues(new Uint8Array(12));
 const info='timelink:offline:v1:'+entitlementId+':'+userId+':'+playerId+':'+sha;
 const hkdf=await crypto.subtle.importKey('raw',binary(shared),'HKDF',false,['deriveKey']);
 const wrapping=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:binary(salt),info:encoder.encode(info)},hkdf,{name:'AES-GCM',length:256},false,['encrypt']);
 const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:binary(nonce),additionalData:encoder.encode(info),tagLength:128},wrapping,binary(contentKey)));
 const jwk=await crypto.subtle.exportKey('jwk',temp.publicKey);
 return {algorithm:'ECDH-P256/HKDF-SHA256/AES-256-GCM',ephemeral_public_key:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},salt:toB64(salt),nonce:toB64(nonce),wrapped_license:toB64(data)};
}
export async function issueOfflineV5(env:Env,input:{userId:number;playerId:string;containerSha256:string;requestId:string;seconds:number}){
 const {userId,playerId,containerSha256,requestId,seconds}=input;
 if(!Number.isSafeInteger(userId)||userId<=0||!validId(playerId)||!validSha(containerSha256)||!validId(requestId)||!Number.isSafeInteger(seconds)||seconds<1||seconds>3600)
   throw Error('OFFLINE_ISSUE_INVALID_INPUT');
 // Keys must be installed before any TL is moved out of the user's balance.
 const signer=await getSignKeys(env);
 await ensureOfflineV5Table(env.DB);
 const entitlementId='u'+userId+'_'+requestId;
 const previous=await env.DB.prepare('SELECT * FROM tl3_v5_offline_entitlements WHERE entitlement_id=?').bind(entitlementId).first<any>();
 if(previous){
   if(Number(previous.user_id)!==userId||previous.player_id!==playerId||previous.container_sha256!==containerSha256||Number(previous.reserved_seconds)!==seconds||previous.status!=='issued')
      throw Error('OFFLINE_ISSUE_REPLAY_CONFLICT');
   return {...exportPayload(previous),signing_public_key:signer.publicDer,replayed:true};
 }
 const [release,device]=await Promise.all([
  env.DB.prepare('SELECT v.file_id,v.user_id AS creator_id,v.share_id,v.container_sha256,v.wrapped_content_key,COALESCE(v.key_id,\'legacy\') AS key_id FROM tl3_v5_releases v JOIN tl_files f ON f.id=v.file_id WHERE v.container_sha256=? AND v.status=\'sealed\' AND f.shared=1 AND LOWER(f.file_type)=\'audio/tl3\' AND COALESCE(f.revenue_held,0)=0 AND EXISTS(SELECT 1 FROM tl_creator_metadata m WHERE m.file_id=v.file_id AND m.user_id=v.user_id AND m.rights_declared=1 AND m.rights_role IN (\'owner\',\'authorized_agent\',\'licensee\') AND m.rights_scope IN (\'master_recording\',\'distribution_license\',\'delegated_scope\') AND m.declaration_status IN (\'declared\',\'verified\',\'approved\')) LIMIT 1').bind(containerSha256).first<any>(),
  env.DB.prepare('SELECT public_jwk FROM tl3_player_keys WHERE user_id=? AND player_id=? AND revoked_at IS NULL').bind(userId,playerId).first<any>()
 ]);
 if(!release||!device)throw Error('OFFLINE_RELEASE_OR_REGISTERED_DEVICE_NOT_FOUND');
 const master=resolveMasterKeyring(env);
 const secret=master.keys[String(release.key_id)];
 if(!secret)throw Error('TL3_MASTER_KEY_MISSING');
 const contentKey=await unwrapAssetKey(secret,Number(release.file_id),String(release.share_id),String(release.wrapped_content_key));
 const issuedAt=Math.floor(Date.now()/1000),expiresAt=issuedAt+24*3600;
 const payload={version:1,type:'timelink.offline.v1',user_id:String(userId),device_id:playerId,container_sha256:containerSha256,entitlement_id:entitlementId,file_tl_reserved:seconds,personal_tl_reserved:0,issued_at:issuedAt,expires_at:expiresAt};
 const raw=encoder.encode(JSON.stringify(payload));
 const signature=toB64(new Uint8Array(await crypto.subtle.sign('Ed25519',signer.privateKey,binary(raw))));
 if(!(await crypto.subtle.verify('Ed25519',signer.publicKey,binary(fromB64(signature)),binary(raw))))throw Error('OFFLINE_SIGNATURE_SELF_TEST_FAILED');
 const grant={payload:toB64(raw),signature};
 const license=await sealForDevice(JSON.parse(String(device.public_jwk)),contentKey,userId,playerId,entitlementId,containerSha256);
 const existing=await env.DB.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind('offline-v5-reserve:'+entitlementId).first<any>();
 if(existing)throw Error('OFFLINE_RESERVATION_RETRY_WITHOUT_ENTITLEMENT');
 const row=env.DB.prepare('INSERT INTO tl3_v5_offline_entitlements (entitlement_id,user_id,player_id,file_id,share_id,container_sha256,reserved_seconds,expires_at,source_atoms_json,grant_json,license_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  .bind(entitlementId,userId,playerId,Number(release.file_id),String(release.share_id),containerSha256,seconds,expiresAt,'{}',JSON.stringify(grant),JSON.stringify(license));
 // Reserve source allocation first; the entitlement is created in the SAME ledger batch.
 const reserved=await reserveOfflineV5TrackTl(env.DB,{userId,shareId:String(release.share_id),entitlementId,seconds,atomicStatements:[row]});
 // The signed response can only exist after money was placed in escrow.
 await env.DB.prepare('UPDATE tl3_v5_offline_entitlements SET source_atoms_json=? WHERE entitlement_id=?').bind(JSON.stringify(reserved.sourceAtoms),entitlementId).run();
 return {ok:true,entitlement_id:entitlementId,file_id:Number(release.file_id),share_id:String(release.share_id),expires_at:expiresAt,grant,license,signing_public_key:signer.publicDer};
}
export async function settleOfflineV5(env:Env,input:{userId:number;entitlementId:string;receipts:{id:string;sequence:number;audibleSeconds:number}[];signature:string}){
 const {userId,entitlementId,receipts,signature}=input;
 if(!Number.isSafeInteger(userId)||userId<=0||typeof entitlementId!=='string'||!/^u[0-9]+_[A-Za-z0-9_-]{16,96}$/.test(entitlementId)||
    !Array.isArray(receipts)||receipts.length>5000||typeof signature!=='string'||signature.length>256)throw Error('OFFLINE_SETTLEMENT_INVALID_INPUT');
 await ensureOfflineV5Table(env.DB);
 const row=await env.DB.prepare('SELECT * FROM tl3_v5_offline_entitlements WHERE entitlement_id=? AND user_id=?').bind(entitlementId,userId).first<any>();
 if(!row)throw Error('OFFLINE_ENTITLEMENT_NOT_FOUND');
 const encoded=encoder.encode(JSON.stringify({entitlement_id:entitlementId,receipts}));
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)),n=>n.toString(16).padStart(2,'0')).join('');
 if(row.status==='settled'){
   if(row.settlement_hash!==digest)throw Error('OFFLINE_SETTLEMENT_REPLAY_CONFLICT');
   return {ok:true,replayed:true,spent_tl:Number(row.settled_seconds||0)};
 }
 if(row.status!=='issued')throw Error('OFFLINE_ENTITLEMENT_NOT_ACTIVE');
 const player=await env.DB.prepare('SELECT public_jwk FROM tl3_player_keys WHERE user_id=? AND player_id=?').bind(userId,row.player_id).first<any>();
 if(!player)throw Error('OFFLINE_DEVICE_NOT_FOUND');
 const verifyKey=await crypto.subtle.importKey('jwk',JSON.parse(String(player.public_jwk)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 if(!(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},verifyKey,binary(fromB64(signature)),binary(encoded)))))
   throw Error('OFFLINE_RECEIPT_SIGNATURE_INVALID');
 const source=JSON.parse(String(row.source_atoms_json||'{}'));
 if(!['paid','bonus','ad'].every(k=>Number.isSafeInteger(source[k])&&source[k]>=0))throw Error('OFFLINE_SOURCE_ALLOCATION_INVALID');
 const result=validateOfflineV5Settlement({entitlementId,fileTlReserved:Number(row.reserved_seconds),personalTlReserved:0,expiresAt:Number(row.expires_at)},receipts,Math.min(Math.floor(Date.now()/1000),Number(row.expires_at)));
 await assertTLAtomScale(env.DB);
 const creator=await env.DB.prepare('SELECT user_id FROM tl3_v5_releases WHERE file_id=? AND share_id=?').bind(row.file_id,row.share_id).first<any>();
 if(!creator)throw Error('OFFLINE_CREATOR_NOT_FOUND');
 const rights=await readCreatorSplit(env.DB,Number(row.file_id));
 const addLines=new Map<string,number>();
 const add=(accountId:string,amount:number)=>addLines.set(accountId,(addLines.get(accountId)||0)+amount);
 let paidRemaining=result.spentTl*TL_ATOMS_PER_TL,creatorTotal=0,platformTotal=0;
 for(const type of ['paid','bonus','ad'] as const){
   const total=source[type];
   const spent=Math.min(total,paidRemaining);paidRemaining-=spent;
   const refund=total-spent;
   if(refund){
     const account=await ensureLedgerAccount(env.DB,'user',userId,'TL','track_pool:'+row.share_id+':'+type);
     add(account,refund);
   }
   if(spent){
     const creatorPart=Math.round(spent*CREATOR_SHARE_RATE),platformPart=spent-creatorPart;
     const platform=await ensureLedgerAccount(env.DB,'platform','timelink','TL','playback_revenue_'+type);
     add(platform,platformPart);
     const creatorBucket=type==='paid'?'wallet_paid':'wallet_bonus';
     if(rights){
       if(!rights.ready){
         const pending=await ensureLedgerAccount(env.DB,'escrow','track:'+row.file_id+':split:'+rights.version,'TL','creator_split_pending_'+type);
         add(pending,creatorPart);
       }else{
         const shares=allocateCreatorAtoms(creatorPart,rights.members.map(m=>({id:String(m.id),share_bps:Number(m.share_bps),recipient_user_id:Number(m.recipient_user_id)})));
         for(const share of shares){
           const dest=await ensureLedgerAccount(env.DB,'user',share.recipient_user_id,'TL',creatorBucket);
           add(dest,share.amount_atoms);
         }
       }
     }else{
       const account=await ensureLedgerAccount(env.DB,'user',Number(creator.user_id),'TL',creatorBucket);
       add(account,creatorPart);
     }
     creatorTotal+=creatorPart;platformTotal+=platformPart;
   }
 }
 if(paidRemaining!==0)throw Error('OFFLINE_SPEND_ALLOCATION_MISMATCH');
 const escrow=await ensureLedgerAccount(env.DB,'escrow',entitlementId,'TL','offline_v5_reserved');
 add(escrow,-Number(row.reserved_seconds)*TL_ATOMS_PER_TL);
 const lines=[...addLines].filter(x=>x[1]!==0).map(([accountId,amountAtoms])=>({accountId,assetCode:'TL' as const,amountAtoms}));
 const posted=await postLedgerTransaction(env.DB,{
  idempotencyKey:'offline-v5-settle:'+entitlementId,transactionType:'offline_v5_settlement',source:'verified_offline_receipts',
  referenceType:'offline_entitlement',referenceId:entitlementId,actorUserId:String(userId),
  description:'검증된 오프라인 청취 사용분 정산 및 미사용 TL 반환',
  metadata:{settlement_hash:digest,spent_seconds:result.spentTl,creator_share_atoms:creatorTotal,platform_share_atoms:platformTotal},
  lines,
  atomicStatements:[env.DB.prepare("UPDATE tl3_v5_offline_entitlements SET status='settled',settled_seconds=?,settlement_hash=? WHERE entitlement_id=? AND status='issued'").bind(result.spentTl,digest,entitlementId)]
 });
 return {ok:true,replayed:posted.replayed,spent_tl:result.spentTl,unused_tl:result.fileUnusedTl,transaction_id:posted.id};
}
