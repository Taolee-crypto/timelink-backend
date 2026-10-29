from unittest import TestCase
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pitch_postprocess import refine_pitch_events


class VocalPitchRefinementTests(TestCase):
    def test_retains_sung_melody_and_corrects_supported_octave(self):
        # 16 frames/second; independent vocal F0 verifies C4.
        frames = [60.0] * 120
        events = [(1.0, 1.7, 72, 0.65), (2.0, 2.6, 62, 0.90)]
        frames[32:42] = [62.0] * 10
        notes, report = refine_pitch_events(events, frames, 1/16, 7.5)
        self.assertEqual([n['m'] for n in notes], [60, 62])
        self.assertEqual(report['octave_corrected'], 1)
        self.assertEqual(report['f0_confirmed'], 1)
    def test_overlapping_harmonic_uses_verified_pitch_not_first_event(self):
        frames=[64.0]*100
        events=[(.5,1.2,76,.59),(.5,1.2,64,.75)]
        notes, report=refine_pitch_events(events, frames, .04, 4)
        self.assertEqual([n['m'] for n in notes],[64])
        self.assertEqual(report['discarded_overlap'],1)
    def test_unstable_f0_does_not_rewrite_real_note(self):
        frames=[None,65,77,55,65,77,55,65]*40
        notes, report=refine_pitch_events([(.5,1.2,65,.9)],frames,.025,5)
        self.assertEqual(len(notes),1)
        self.assertEqual(notes[0]['m'],65)
        self.assertEqual(report['octave_corrected'],0)
    def test_conflicting_weak_short_note_removed_without_inventing_notes(self):
        frames=[60.0]*100
        notes,report=refine_pitch_events([(.5,.7,80,.52)],frames,.02,2)
        self.assertEqual(notes,[])
        self.assertEqual(report['discarded_unsupported'],1)
    def test_no_f0_keeps_note_for_creator_review(self):
        notes,report=refine_pitch_events([(0.3,.7,65,.9)],[None]*60,.02,2)
        self.assertEqual(notes,[{'s':.3,'d':.4,'m':65}])
        self.assertEqual(report['f0_confirmed'],0)
    def test_rejects_invalid_events_and_monophonic_output(self):
        frames=[60.0]*100
        events=[(0,0.05,60,.9),(.2,1.0,60,.9),(.6,1.3,60,.7),(float('nan'),2,60,.9)]
        notes,report=refine_pitch_events(events,frames,.02,4)
        self.assertTrue(all(notes[i]['s'] >= notes[i-1]['s'] + notes[i-1]['d']-.001 for i in range(1,len(notes))))
        self.assertEqual(report['total_notes'],len(notes))
