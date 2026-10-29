export function validateScoreLyrics(score:any, original:string, duration:number):boolean {
  const text=original.replace(/\[[^\]\n]*\]/g,'').split('\n').map(x=>x.trim()).filter(Boolean).join('\n');
  if(!text)return score.lyrics_status==='not_provided'&&Array.isArray(score.lyrics_words)&&score.lyrics_words.length===0;
  if(score.lyrics_status!=='aligned_draft'||!Array.isArray(score.lyrics_words)||score.lyrics_words.length<1||score.lyrics_words.length>10000||score.lyrics_alignment?.engine!=='stable-ts-whisper-small'||score.lyrics_alignment?.source!=='creator_supplied')return false;
  let end=0;
  for(const word of score.lyrics_words){
    if(typeof word?.text!=='string'||word.text.length<1||word.text.length>500||!Number.isFinite(word.s)||!Number.isFinite(word.d)||word.s<0||word.s<end-0.03||word.d<=0||word.s+word.d>duration+0.1)return false;
    end=word.s+word.d;
  }
  return score.lyrics_words.map((w:any)=>w.text).join('').replace(/\s/g,'')===text.replace(/\s/g,'');
}
