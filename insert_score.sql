UPDATE tl3_releases
SET header_json = json_set(
  header_json,
  '$.score',
  json('{"version":1,"generated_at":"2026-10-12T12:00:00Z","algorithm":"timelink-score-v0.1","key":{"tonic":"C","mode":"major","sharps_flats":0,"conf":0.9},"time_signature":"4/4","bpm":120,"melody":[{"s":0.5,"d":0.5,"m":60,"conf":0.95},{"s":1.0,"d":0.5,"m":62,"conf":0.93},{"s":1.5,"d":0.5,"m":64,"conf":0.94},{"s":2.0,"d":0.5,"m":65,"conf":0.92},{"s":2.5,"d":0.5,"m":67,"conf":0.93},{"s":3.0,"d":0.5,"m":69,"conf":0.94},{"s":3.5,"d":0.5,"m":71,"conf":0.92},{"s":4.0,"d":0.5,"m":72,"conf":0.93}],"chords":[{"s":0.0,"e":2.0,"sym":"C","conf":0.9},{"s":2.0,"e":4.0,"sym":"Am","conf":0.9},{"s":4.0,"e":6.0,"sym":"F","conf":0.9},{"s":6.0,"e":8.0,"sym":"G","conf":0.9}],"lyrics":[]}')
)
WHERE share_id='sh_1791770652897_fwm8n';