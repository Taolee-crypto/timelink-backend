'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {transformSync}=require('esbuild');
const src=fs.readFileSync('src/v5-score-lyrics.ts','utf8');
const compiled=transformSync(src,{loader:'ts',format:'cjs'}).code;
const mod={exports:{}};
vm.runInNewContext(compiled,{module:mod,exports:mod.exports,require,console});
const validate=mod.exports.validateScoreLyrics;
const pending={
  part:'lead_vocal',
  melody:[{s:1,d:.5,m:62}],
  lyrics_status:'alignment_pending',lyrics_words:[],
  lyrics_alignment:{engine:'stable-ts-whisper-small',source:'creator_supplied',
    review_required:true,pending_reason:'VOICE_WORD_ALIGNMENT_UNCERTAIN'}
};
assert.equal(validate(pending,'Hello',4),true);
assert.equal(validate({...pending,lyrics_words:[{s:1,d:0,text:'Hello'}]},'Hello',4),false);
assert.equal(validate({...pending,melody:[{s:1,d:.5,m:62,lyric:'made-up'}]},'Hello',4),false);
assert.equal(validate({...pending,lyrics_alignment:{...pending.lyrics_alignment,review_required:false}},'Hello',4),false);
assert.equal(validate(pending,'',4),false);
const aligned={
  ...pending,lyrics_status:'aligned_draft',lyrics_words:[{s:1,d:.5,text:'Hello'}],
  melody:[{s:1,d:.5,m:62,lyric:'Hello'}]
};
assert.equal(validate(aligned,'Hello',4),true);
assert.equal(validate(aligned,'Goodbye',4),false);
console.log('PASS owner lyrics pending only with real melody, no fabricated timing, original aligned contract intact');
