"""Align creator-supplied lyrics to the separated vocal, never invent lyrics."""
import math
import re
import sys

class LyricsAlignmentUncertain(ValueError):
    """Supplied lyrics remain valid, but word-to-note timing is unverified."""


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
                    if distance <= 0.20 and note_end >= previous + 0.04 and note_end >= raw_start + 0.03:
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
        if overlap <= 0:
            # Display the supplied word on a nearby REAL vocal note, without
            # changing its verified timestamp. The notation placement is
            # approximate and explicitly marked for human review.
            distances = [(max(n['s']-(word['s']+word['d']),
                              word['s']-(n['s']+n['d']), 0), i) for i,n in enumerate(notes)]
            gap,index = min(distances)
            if gap > 0.25:
                word['note_display_unattached'] = True
                continue
            word['note_display_approx'] = True
        notes[index]['lyric'] = (notes[index].get('lyric','')+' '+word['text']).strip()
    return words


def align_lyrics(vocals, lyrics, notes, duration):
    text = clean_lyrics(lyrics)
    if not text:
        return {'lyrics_status':'not_provided','lyrics_words':[]}
    import stable_whisper
    language = 'ko' if re.search('[가-힣]',text) else 'en'
    print('V5_SCORE_STAGE:lyrics_model', file=sys.stderr, flush=True)
    model = stable_whisper.load_model('small', device='cpu')
    # Long, sung lyrics can produce word timestamps at non-vocal positions.
    # Retry legitimate forced-alignment configurations on the SAME vocal stem.
    # Reject all candidates that do not preserve the creator's exact lyrics,
    # or that fail authentic note-anchored timing validation.
    strategies = (
        {'original_split': True},
        {'original_split': True, 'fast_mode': True, 'nonspeech_skip': None, 'token_step': 200},
        {'original_split': False, 'fast_mode': True, 'nonspeech_skip': None, 'token_step': 200},
    )
    expected = re.sub(r'\s', '', text)
    final_reason = 'INVALID_ALIGNMENT_STRUCTURE'
    for options in strategies:
        try:
            print('V5_SCORE_STAGE:lyrics_align', file=sys.stderr, flush=True)
            result = model.align(str(vocals), text, language=language, verbose=None, **options)
            if result is None:
                final_reason = 'NO_ALIGNED_WORDS'
                continue
            # A failed candidate must never contaminate the note melody.
            candidate_notes = [dict(note) for note in notes]
            print('V5_SCORE_STAGE:lyrics_attach', file=sys.stderr, flush=True)
            words = attach_words(candidate_notes, result.to_dict()['segments'], duration)
            print('V5_SCORE_STAGE:lyrics_verify', file=sys.stderr, flush=True)
            if re.sub(r'\s', '', ''.join(word['text'] for word in words)) != expected:
                final_reason = 'LYRICS_SOURCE_MISMATCH'
                continue
            # Commit annotations only after complete time/text validation.
            # Approximate *display placement* is never a fabricated timestamp.
            display_snapped = sum(bool(word.get('note_display_approx')) for word in words)
            display_unattached = sum(bool(word.get('note_display_unattached')) for word in words)
            for original, candidate in zip(notes, candidate_notes):
                if 'lyric' in candidate:
                    original['lyric'] = candidate['lyric']
            return {
                'lyrics_status': 'aligned_draft', 'lyrics_words': words,
                'lyrics_alignment': {'engine':'stable-ts-whisper-small',
                                     'language':language,'source':'creator_supplied',
                                     'review_required':True,
                                     'note_display_snap_count':display_snapped,
                                     'note_display_unattached_count':display_unattached}
            }
        except (ValueError, KeyError, TypeError, IndexError) as error:
            allowed = {
                'INVALID_VOCAL_NOTES', 'INVALID_WORD_TIMESTAMP',
                'WORD_OUTSIDE_AUDIO', 'WORD_TIMING_OUT_OF_ORDER',
                'WORD_HAS_NO_VOCAL_ANCHOR', 'WORD_HAS_NO_VALID_DURATION',
                'NO_ALIGNED_WORDS'
            }
            reason = str(error) if isinstance(error, ValueError) else ''
            final_reason = reason if reason in allowed else 'INVALID_ALIGNMENT_STRUCTURE'
    # If every genuine alignment attempt failed, preserve the failure.
    # No fabricated timestamps, shortened lyrics, or unreviewed score.
    print('V5_SCORE_STAGE:lyrics_attach', file=sys.stderr, flush=True)
    print('V5_SCORE_REASON:' + final_reason, file=sys.stderr, flush=True)
    raise LyricsAlignmentUncertain('Forced lyrics did not satisfy vocal-note alignment')
