# TILO V5 independent server clock — phase 1

Cloudflare Cron refreshes six country clocks once per minute, independent of any user's browser or PC.
Timezone calculations use IANA zones (including New York DST).
Read-only endpoint: `GET /api/tilo/server-clock` returns current server-derived show and voice profile per country.
D1 table `tilo_country_clock` retains the last refresh timestamp.
This **does not yet create a continuous audio stream**: next phase needs authorized shared broadcast playout, server-side track position/timeline, secure TL3 segment delivery and audited airtime. Never treat cron heartbeat as proof of audible playback or a payable event.
Existing V5 playback, grant checking, and 0.3 weighted 7:3 settlement are untouched.
