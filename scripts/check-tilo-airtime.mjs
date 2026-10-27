#!/usr/bin/env node
// External watchdog probe. Does not restart a broadcaster or initiate payouts.
const base=process.env.TIMELINK_API_BASE||'https://api.timelink.digital';
const admin=process.env.TILO_BROADCAST_ADMIN_ID;
const secret=process.env.CENTRAL_BROADCAST_WORKER_SECRET;
if(!admin||!secret||!/^\d+$/.test(admin)){
 console.error('Missing TILO_BROADCAST_ADMIN_ID or CENTRAL_BROADCAST_WORKER_SECRET');
 process.exit(2);
}
const url=new URL('/api/v5/central-broadcast/airtime/freshness',base);
url.searchParams.set('admin_id',admin);
try{
 const response=await fetch(url,{headers:{'X-Central-Broadcast-Secret':secret},signal:AbortSignal.timeout(10000)});
 const data=await response.json();
 if(!response.ok||!data.ok){console.error('TILO monitoring API unavailable',response.status,data.error||'');process.exit(2);}
 if(!data.enabled){console.error('TILO broadcast service is disabled');process.exit(2);}
 if(data.airtime_stale){console.error('TILO airtime records stale',data.last_airtime_ended_at||'no evidence');process.exit(1);}
 console.log('TILO airtime records recent',data.last_airtime_ended_at);
}catch(error){console.error('TILO watchdog probe failed',String(error.message||error));process.exit(2);}
