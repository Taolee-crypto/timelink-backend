'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const s=fs.readFileSync('src/routes/tl3-v5.ts','utf8');
const a=s.indexOf("router.post('/offline/grant/:sha256'"),b=s.indexOf("router.post('/session-license/:id'",a);
assert.ok(a>0&&b>a,'offline grant route');
const route=s.slice(a,b);
for(const v of ['reserveOfflineV5TrackTl','container_sha256=?','player_id','entitlement_id',
 'ECDH-P256/HKDF-SHA256/AES-256-GCM','file_tl_reserved','wrapped_license','expires_at'])
 assert.ok(route.includes(v),v);
assert.ok(route.indexOf('reserveOfflineV5TrackTl')<route.indexOf('return c.json({ok:true'),'reservation must commit before grant response');
assert.ok(route.includes("contentKey.fill(0)"),'server plaintext key must be zeroed before response');
console.log('PASS V5 offline grant reservation and device envelope contract');
