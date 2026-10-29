'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const app=fs.readFileSync('src/index.ts','utf8');
assert.ok(!app.includes("import scoreRouter from './routes/score'"), 'score router still imported');
assert.ok(!app.includes("app.route('/api/v1', scoreRouter)"), 'score API still mounted');
assert.ok(!fs.existsSync('.github/workflows/v5-vocal-inference.yml'),
  'automatic OIDC inference workflow must be removed');
assert.ok(fs.existsSync('src/routes/tl3-v5.ts'), 'TL3 music service must remain');
assert.ok(fs.existsSync('src/routes/score.ts'), 'historical score data adapter preserved in source');
assert.ok(fs.existsSync('src/tld-score-core.ts'), 'shared TLD crypto contract preserved');
assert.ok(app.includes("tl3V5Router"), 'TL3 encrypted audio must remain active');
console.log('PASS: score HTTP service and scheduled inference retired, TL3 and archival data untouched');
