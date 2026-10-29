import sys
from pathlib import Path
from unittest import TestCase
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from lyrics_alignment import clean_lyrics, attach_words
class AlignmentTests(TestCase):
    def test_labels_and_timestamps_not_sung(self):
        self.assertEqual(clean_lyrics('[Verse 1]\n[00:12.4] 사랑해\n[Chorus]\n너를'), '사랑해\n너를')
    def test_words_attach_only_to_overlapping_notes(self):
        notes=[{'s':1,'d':1,'m':60},{'s':4,'d':1,'m':62}]
        words=attach_words(notes,[{'words':[{'word':'사랑해','start':1.1,'end':1.8}]}],10)
        self.assertEqual(notes[0]['lyric'],'사랑해'); self.assertNotIn('lyric',notes[1]); self.assertEqual(len(words),1)
    def test_reject_out_of_order_or_zero_length(self):
        for start,end in [(2,1),(1,1),(0,12)]:
            with self.assertRaises(ValueError): attach_words([{'s':0,'d':1,'m':60}],[{'words':[{'word':'a','start':start,'end':end}]}],10)

    def test_small_word_overlap_is_normalized_monotonically(self):
        notes=[{'s':0.8,'d':1.0,'m':64},{'s':1.8,'d':1.0,'m':65}]
        words=attach_words(notes,[{'words':[
            {'word':'red','start':1.0,'end':1.45},
            {'word':'yellow','start':1.40,'end':2.1}
        ]}],3.0)
        self.assertEqual([w['text'] for w in words],['red','yellow'])
        self.assertGreaterEqual(words[1]['s'],words[0]['s']+words[0]['d']-0.001)
        self.assertIn('red',notes[0]['lyric'])
    def test_collapsed_word_must_have_actual_vocal_anchor(self):
        notes=[{'s':0.0,'d':0.5,'m':60},{'s':1.0,'d':0.6,'m':62}]
        words=attach_words(notes,[{'words':[{'word':'hey','start':1.1,'end':1.1}]}],2.0)
        self.assertEqual(words[0]['text'],'hey')
        self.assertGreaterEqual(words[0]['d'],0.025)
        with self.assertRaises(ValueError):
            attach_words(notes,[{'words':[{'word':'not-sung','start':1.9,'end':1.9}]}],2.0)

    def test_nearby_word_is_displayed_without_modifying_its_timestamp(self):
        notes=[{'s':1.0,'d':0.5,'m':64},{'s':2.0,'d':0.5,'m':65}]
        words=attach_words(notes,[{'words':[{'word':'hello','start':1.72,'end':1.80}]}],3.0)
        self.assertEqual(notes[1]['lyric'],'hello')
        self.assertEqual(words[0]['s'],1.72)
        self.assertEqual(words[0]['d'],0.08)
        self.assertEqual(words[0]['note_display_approx'],True)
    def test_distant_word_not_falsely_attached_to_any_vocal_note(self):
        notes=[{'s':1.0,'d':0.5,'m':64}]
        words=attach_words(notes,[{'words':[{'word':'hushed','start':2.0,'end':2.2}]}],3.0)
        self.assertNotIn('lyric',notes[0])
        self.assertEqual(words[0]['note_display_unattached'],True)
        self.assertEqual(words[0]['text'],'hushed')
