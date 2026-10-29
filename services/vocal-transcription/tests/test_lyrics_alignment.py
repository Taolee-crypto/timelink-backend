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
