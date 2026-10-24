import type { Env } from './types';
import { ensureD1Storage,putD1Object,getD1ObjectMeta,readD1Range } from './d1-storage';
// Reuse the deployed storage backend. The current Worker has a D1 binding;
// R2 remains optional. Authorization belongs to the owning API, never the key.
export async function putV5Object(env:Env,key:string,data:Uint8Array,type:string){
  if(env.R2){await env.R2.put(key,data,{httpMetadata:{contentType:type}});return;}
  await ensureD1Storage(env.DB);
  try{await putD1Object(env.DB,key,data,type,key);}catch(e){await deleteV5Object(env,key);throw e;}
}
export async function deleteV5Object(env:Env,key:string){
  if(env.R2)await env.R2.delete(key);
  await ensureD1Storage(env.DB);
  await env.DB.batch([env.DB.prepare('DELETE FROM tl_d1_object_parts WHERE object_key=?').bind(key),
    env.DB.prepare('DELETE FROM tl_d1_objects WHERE object_key=?').bind(key)]);
}
export async function readV5Object(env:Env,key:string):Promise<BodyInit|null>{
  if(env.R2){const obj=await env.R2.get(key);if(obj)return obj.body;}
  await ensureD1Storage(env.DB);
  const meta=await getD1ObjectMeta(env.DB,key);if(!meta)return null;
  const value=await readD1Range(env.DB,key,0,meta.size);
  return value as unknown as BodyInit;
}
