/**
 * Read-only post-deploy production smoke: verifies that funded TILO promotion
 * candidates survive in the live API without manufacturing airtime or payouts.
 * This intentionally does not start playback or require any listener session.
 */
const uri='https://api.timelink.digital/api/v5/central-broadcast/stations/KR';
let last;
for(let attempt=1;attempt<=6;attempt++){
  try{
    const r=await fetch(uri,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(12000)});
    const data=await r.json();
    if(r.status!==200||data.ok!==true)throw Error('Production TILO KR station HTTP '+r.status+' / '+String(data.error||'invalid'));
    if(!Array.isArray(data.tracks)||!Array.isArray(data.granted_file_ids))
      throw Error('Production station playlist missing');
    if(!data.service_enabled||data.tracks.length===0)
      throw Error('Production TILO KR has no verified V5 broadcast inventory');
    const promoted=data.tracks.filter(t=>t.is_promoted===true).length;
    const ordinary=data.tracks.filter(t=>t.is_promoted!==true).length;
    if(!Number.isSafeInteger(data.promoted_count)||data.promoted_count!==promoted||
       !Number.isSafeInteger(data.ordinary_count)||data.ordinary_count!==ordinary)
      throw Error('Promotional/ordinary metadata does not match actual production playlist');
    if(data.promoted_count===0)
      throw Error('Funded promotion candidates are missing in production station');
    if(data.requires_separate_admin_country_grant!==false)
      throw Error('TILO broadcast incorrectly requires duplicate administrator country grants');
    if(data.tracks.length!==data.granted_file_ids.length)
      throw Error('Playback file list length does not match priority schedule');
    const idSet=new Set(data.granted_file_ids);
    if(idSet.size!==data.granted_file_ids.length)
      throw Error('Broadcast station returned duplicate tracks');
    if(data.tracks.some((t,i)=>t.file_id!==data.granted_file_ids[i]))
      throw Error('Broadcast priority order lost between playlist and playback');
    if(data.server_audio_stream!==false||data.posted!==false)
      throw Error('Production API falsely claims independent live playout or settlement');
    console.log('PASS LIVE TILO KR: '+data.promoted_count+
      ' funded priority tracks, '+data.ordinary_count+
      ' ordinary fallback tracks, no extra approvals, no fake airtime/payout');
    process.exit(0);
  }catch(e){
    last=e;console.error('TILO KR production smoke attempt '+attempt+': '+String(e?.message||e));
    if(attempt<6)await new Promise(resolve=>setTimeout(resolve,4000));
  }
}
throw last;
