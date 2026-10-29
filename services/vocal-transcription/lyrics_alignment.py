"""Align creator-supplied lyrics to the separated vocal, never invent lyrics."""
import math
import re
import sys

def clean_lyrics(text):
    # Section labels and LRC timestamps are metadata, not sung words.
    return '\n'.join(line.strip() for line in re.sub(r'\[[^\]\n]*\]', '', text).splitlines() if line.strip())

def attach_words(notes, segments, duration):
    words = []
    previous = 0.0
    for segment in segments:
        for word in segment.get('words', []):
            text = str(word['word']).strip()
            start, end = float(word['start']), float(word['end'])
            if not text or not all(map(math.isfinite, (start,end))) or start < previous - 0.03 or not 0 <= start < end <= duration + 0.1:
                raise ValueError('Invalid lyric alignment')
            words.append({'s':round(start,3), 'd':round(end-start,3), 'text':text})
            previous = end
    if not words: raise ValueError('No aligned lyrics')
    for word in words:
        overlaps = [(min(n['s']+n['d'],word['s']+word['d'])-max(n['s'],word['s']),i) for i,n in enumerate(notes)]
        overlap,index = max(overlaps)
        if overlap > 0:
            notes[index]['lyric'] = (notes[index].get('lyric','')+' '+word['text']).strip()
    return words

def align_lyrics(vocals, lyrics, notes, duration):
    text = clean_lyrics(lyrics)
    if not text: return {'lyrics_status':'not_provided','lyrics_words':[]}
    import stable_whisper
    language = 'ko' if re.search('[가-힣]',text) else 'en'
    print('V5_SCORE_STAGE:lyrics_model', file=sys.stderr, flush=True)
    model = stable_whisper.load_model('small', device='cpu')
    print('V5_SCORE_STAGE:lyrics_align', file=sys.stderr, flush=True)
    result = model.align(str(vocals),text,language=language,original_split=True,verbose=None)
    if result is None: raise ValueError('Lyrics alignment failed')
    print('V5_SCORE_STAGE:lyrics_attach', file=sys.stderr, flush=True)
    words = attach_words(notes,result.to_dict()['segments'],duration)
    print('V5_SCORE_STAGE:lyrics_verify', file=sys.stderr, flush=True)
    if re.sub(r'\s','', ''.join(w['text'] for w in words)) != re.sub(r'\s','',text):
        raise ValueError('Alignment did not preserve supplied lyrics')
    return {'lyrics_status':'aligned_draft','lyrics_words':words,
            'lyrics_alignment':{'engine':'stable-ts-whisper-small','language':language,'source':'creator_supplied','review_required':True}}
