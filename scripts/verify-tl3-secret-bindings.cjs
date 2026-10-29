// Read only binding names; never read, recreate, upload, or rotate encryption keys.
(async()=>{
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 if(!account||!token)throw Error('Cloudflare deploy credentials missing');
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/timelink-backend/secrets`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
 const data=await r.json();
 if(!r.ok||!data.success)throw Error('Cannot verify existing TL3 secret bindings');
 const names=new Set(data.result.map(b=>b.name));
 for(const name of ['TL3_MASTER_KEYRING','TL3_MASTER_KEY_ACTIVE_ID','TL3_MASTER_SECRET'])if(!names.has(name))throw Error(`Required existing secret missing: ${name}. Restore original value; do not generate a replacement.`);
 console.log('PASS existing TL3 secret bindings present (values neither read nor changed)');
})().catch(e=>{console.error(e.message);process.exitCode=1});
