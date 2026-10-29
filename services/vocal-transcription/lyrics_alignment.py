"""Align creator-supplied lyrics to the separated vocal, never invent lyrics."""
import math
import re
import sys

def clean_lyrics(text):
    # Section labels and LRC timestamps are metadata, not sung words.
    return '\n'.join(line.strip() for line in re.sub(r'\[[^\]\n]*\]', '', text).splitlines() if line.strip())

def attach_words(notes, segments, duration):
    # Stable-ts can return small overlaps and zero-width word timings for
    # singing. Normalize only near genuine vocal notes; never create lyrics,
    # alter the original text, or accept distant/unanchored timestamps.
    if not notes or not math.isfinite(duration) or duration <= 0:
        raise ValueError('INVALID_VOCAL_NOTES')
    words = []
    previous = 0.0
    for segment in segments:
        for item in segment.get('words') or []:
            text = str(item.get('word') or '').strip()
            if not text:
                continue
            try:
                raw_start, raw_end = float(item['start']), float(item['end'])
            except (KeyError, TypeError, ValueError):
                raise ValueError('INVALID_WORD_TIMESTAMP') from None
            if (not all(map(math.isfinite, (raw_start, raw_end)))
                or raw_start < -0.05 or raw_start > duration + 0.05
                or raw_end < raw_start - 0.05 or raw_end > duration + 0.1):
                raise ValueError('WORD_OUTSIDE_AUDIO')
            if raw_start < previous - 0.35:
                raise ValueError('WORD_TIMING_OUT_OF_ORDER')
            start = max(0.0, previous, raw_start)
            end = min(duration, raw_end)
            if end - start < 0.025:
                # Bind a collapsed/near-overlapping word to a nearby REAL
                # detected vocal note; reject if no reliable note exists.
                candidates = []
                for note in notes:
                    note_start = float(note['s'])
                    note_end = note_start + float(note['d'])
                    distance = max(0.0, note_start - raw_start, raw_start - note_end)
                    if distance <= 0.20 and note_end >= previous + 0.04:
                        candidates.append((distance, note_start, note_end))
                if not candidates:
                    raise ValueError('WORD_HAS_NO_VOCAL_ANCHOR')
                _, note_start, note_end = min(candidates)
                start = max(previous, note_start, min(start, note_end - 0.04))
                end = min(duration, note_end, max(start + 0.04, end))
                if end - start < 0.025:
                    raise ValueError('WORD_HAS_NO_VALID_DURATION')
            words.append({'s':round(start,3), 'd':round(end-start,3), 'text':text})
            previous = end
    if not words:
        raise ValueError('NO_ALIGNED_WORDS')
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
