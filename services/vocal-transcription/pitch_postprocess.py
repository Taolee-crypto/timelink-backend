"""Pure, deterministic post-processing of Basic Pitch against actual vocal F0.

The F0 observations are taken ONLY from the separated vocal stem. Missing
observations never manufacture notes; strong source disagreements are retained
for human review rather than silently turned into incorrect pitches.
"""
from __future__ import annotations
from math import isfinite
from statistics import median


def refine_pitch_events(events, midi_frames, frame_seconds, duration):
    if not frame_seconds > 0 or not duration > 0:
        raise ValueError("Invalid vocal contour")
    candidates = []
    report = {
        'raw_events': 0, 'discarded_short_or_weak': 0,
        'discarded_unsupported': 0, 'discarded_overlap': 0,
        'f0_confirmed': 0, 'octave_corrected': 0, 'pitch_review_notes': 0,
    }
    for event in events:
        report['raw_events'] += 1
        if len(event) < 4:
            continue
        start, end, pitch, confidence = event[:4]
        try:
            start, end, pitch, confidence = map(float, (start, end, pitch, confidence))
        except (ValueError, TypeError):
            continue
        if not all(isfinite(x) for x in (start, end, pitch, confidence)):
            continue
        midi = int(round(pitch))
        if not (21 <= midi <= 108 and 0 <= start < end <= duration + 0.1):
            continue
        if end-start < 0.10 or confidence < 0.46:
            report['discarded_short_or_weak'] += 1
            continue
        # Use the middle of a sung note; onset consonants often have noisy F0.
        inset = min(0.04, (end-start)*0.20)
        left = max(0, int((start+inset)/frame_seconds))
        right = min(len(midi_frames), int((end-inset)/frame_seconds)+1)
        observed = [float(v) for v in midi_frames[left:right]
                    if v is not None and isfinite(float(v))]
        checked = False
        review = False
        if len(observed) >= 4:
            mid = median(observed)
            stable = median([abs(v-mid) for v in observed]) <= 1.15
            density = len(observed)/max(1, right-left)
            if stable and density >= 0.55:
                difference = mid - midi
                if abs(difference) <= 1.5:
                    checked = True
                    report['f0_confirmed'] += 1
                elif 11.0 <= abs(difference) <= 13.0 and confidence < 0.80:
                    # Correct a low-confidence harmonic/octave error ONLY when
                    # the separate vocal-F0 estimator is stable across the note.
                    midi = int(round(mid))
                    checked = True
                    report['octave_corrected'] += 1
                elif abs(difference) > 2.5:
                    if confidence < 0.60 and end-start < 0.24:
                        report['discarded_unsupported'] += 1
                        continue
                    review = True
        candidates.append({
            's': start, 'e': end, 'm': midi, 'confidence': confidence,
            'f0_verified': checked, 'pitch_review': review,
            'ranking': confidence + (0.20 if checked else 0.0)
                       + min(0.12, (end-start)*0.10)
        })
    # Basic Pitch may detect harmonics as *simultaneous* notes. Suppress a
    # weaker overlapping detection instead of arbitrarily truncating first.
    winners = []
    for candidate in sorted(candidates, key=lambda x: x['ranking'], reverse=True):
        if any(max(0.0, min(candidate['e'], n['e']) - max(candidate['s'], n['s']))
               > min(candidate['e']-candidate['s'], n['e']-n['s'])*0.55
               for n in winners):
            report['discarded_overlap'] += 1
            continue
        winners.append(candidate)
    notes = []
    for item in sorted(winners, key=lambda x: (x['s'], x['e'])):
        start = max(item['s'], notes[-1]['s']+notes[-1]['d'] if notes else 0)
        end = min(duration, item['e'])
        if end-start < 0.08:
            report['discarded_overlap'] += 1
            continue
        note = {'s': round(start, 3), 'd': round(end-start, 3), 'm': item['m']}
        if item['pitch_review']:
            note['pitch_review'] = True
            report['pitch_review_notes'] += 1
        notes.append(note)
    for i in range(1, len(notes)):
        if notes[i]['s'] - notes[i-1]['s']-notes[i-1]['d'] < 0.1 and abs(notes[i]['m']-notes[i-1]['m']) >= 12:
            notes[i]['pitch_review'] = True
            if not winners:  # no-op; guarded to keep count stable
                pass
    report['total_notes'] = len(notes)
    report['pitch_review_notes'] = sum(bool(n.get('pitch_review')) for n in notes)
    return notes, report
