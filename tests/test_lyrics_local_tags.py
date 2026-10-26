from backend import config
from backend.lyrics import read_lyrics
from scripts.enrich_local_tags import enrich
from tests.test_library import wav
from mutagen.wave import WAVE
from mutagen.id3 import USLT, SYLT

def test_embedded_unsynced_and_synced_lyrics(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ROOT', tmp_path)
    path = wav(tmp_path / 'song.wav')
    audio = WAVE(path); audio.add_tags()
    audio.tags.add(USLT(encoding=3, lang='eng', text='Embedded words')); audio.save()
    song = {'path': 'song.wav', 'title': 'Question?', 'start': 0, 'metadata': {}}
    assert read_lyrics(song)['text'] == 'Embedded words'
    audio.tags.add(SYLT(encoding=3, lang='eng', format=2, type=1, text=[('Timed words', 1250)])); audio.save()
    assert read_lyrics(song)['text'] == '[00:01.250]Timed words'

def test_local_lyrics_timed_sidecar_and_embedded_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ROOT', tmp_path)
    song = {'path': 'album.flac', 'title': 'Track 2', 'start': 60, 'metadata': {'lyrics': 'embedded words'}}
    (tmp_path / 'album.lrc').write_text('[01:00.00]Hello', encoding='utf-8')
    assert read_lyrics(song)['offset'] == 60
    (tmp_path / 'Track 2.lrc').write_text('[00:00.00]Track words', encoding='utf-8')
    assert read_lyrics(song)['offset'] == 0
    (tmp_path / 'Track 2.lrc').unlink(); (tmp_path / 'album.lrc').unlink()
    assert read_lyrics(song)['text'] == 'embedded words'
    song['metadata'] = {}
    assert read_lyrics(song)['text'] == ''

def test_taxonomy_preserves_existing_tags_and_leaves_unknowns_unfilled():
    track = {'title': 'Piano Sonata: Adagio', 'folder': 'Classical/Album', 'genre': 'Classical', 'album': 'Album', 'ai_tags': {}}
    result = enrich(track)
    assert '钢琴' in result['instruments'] and '舒缓' in result['moods']
    assert result['language'] == '' and result['basis'] == 'metadata_inference'
    assert enrich({**track, 'ai_tags': result}) == result
    unknown = enrich({**track, 'title': 'Track 1', 'ai_tags': {'styles': ['已有风格'], 'moods': ['已有情感'], 'source': 'manual', 'reason': 'original'}})
    assert '已有风格' in unknown['styles'] and unknown['moods'] == ['已有情感']
    assert unknown['previous_reason'] == 'original'
    assert enrich({**track, 'title': 'Track 1', 'ai_tags': unknown}) == unknown
