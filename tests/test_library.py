import hashlib
import os
import shutil
import subprocess
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import config, db, scanner
from backend.main import app


@pytest.fixture
def library(tmp_path, monkeypatch):
    root = tmp_path / 'music'
    root.mkdir()
    data = tmp_path / 'data'
    for p in (data, data/'covers', data/'transcode'):
        p.mkdir(exist_ok=True)
    monkeypatch.setattr(config, 'ROOT', root)
    monkeypatch.setattr(config, 'DATA', data)
    monkeypatch.setattr(db, 'DB_PATH', data/'test.sqlite3')
    monkeypatch.setattr(config, 'PASSWORD', 'test-password')
    monkeypatch.setenv('SCAN_ON_START', 'false')
    db.init()
    scanner.pending.clear()
    return root


def wav(path, seconds=2):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as f:
        f.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
        f.writeframes(b'\0' * int(44100 * seconds) * 4)
    return path


def all_tracks():
    with db.connect() as conn:
        return [dict(r) for r in conn.execute('SELECT * FROM tracks WHERE available=1 AND hidden=0 ORDER BY track_no')]


def test_incremental_and_rename(library):
    path = wav(library/'分类'/'专辑'/'01 - 夏日.wav')
    assert scanner.scan()
    original = all_tracks()[0]
    assert original['title'] == '夏日'
    assert scanner.state['updated'] == 1
    assert scanner.scan()
    assert scanner.state['updated'] == 0 and scanner.state['unchanged'] == 1
    with db.connect() as conn:
        conn.execute('UPDATE tracks SET favorite=1 WHERE id=?', (original['id'],))
    renamed = path.with_name('02 - 改名.wav')
    path.rename(renamed)
    scanner.scan()
    renamed_track = all_tracks()[0]
    assert renamed_track['id'] == original['id'] and renamed_track['favorite'] == 1
    with db.connect() as conn:
        assert conn.execute('SELECT count(*) FROM tracks_fts WHERE id=?',(original['id'],)).fetchone()[0] == 1
    wav(library/'分类'/'专辑'/'新曲.wav', 1)
    scanner.scan('分类/专辑')
    assert len(all_tracks()) == 2 and scanner.state['updated'] == 1
    renamed.unlink()
    scanner.scan('分类/专辑')
    assert len(all_tracks()) == 1


def test_cover_only_change(library):
    path = wav(library/'Album'/'01.wav')
    image = path.parent/'cover.jpg'
    Image.new('RGB', (50, 50), 'red').save(image)
    scanner.scan()
    old_cover = all_tracks()[0]['cover']
    assert old_cover
    Image.new('RGB', (60, 60), 'blue').save(image)
    scanner.scan()
    assert all_tracks()[0]['cover'] != old_cover
    image.unlink()
    scanner.scan()
    assert all_tracks()[0]['cover'] is None


def test_cue_virtual_tracks(library):
    wav(library/'Album'/'album.wav', 4)
    cue = library/'Album'/'album.cue'
    cue.write_text('PERFORMER "Artist"\nTITLE "Album"\nFILE "album.wav" WAVE\n  TRACK 01 AUDIO\n    TITLE "First"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "Second"\n    INDEX 01 00:02:00\n', encoding='utf-8')
    scanner.scan()
    tracks = all_tracks()
    assert len(tracks) == 2 and tracks[0]['title'] == 'First'
    assert tracks[1]['start'] == 2 and tracks[1]['duration'] == 2
    scanner.scan()
    assert scanner.state['updated'] == 0
    cue.unlink()
    scanner.scan()
    assert len(all_tracks()) == 1 and all_tracks()[0]['cue_path'] is None


def test_api_auth_range_playlists_and_traversal(library):
    source = wav(library/'Album'/'source.wav')
    scanner.scan()
    track_id = all_tracks()[0]['id']
    with TestClient(app) as client:
        assert client.get('/api/tracks').status_code == 401
        assert client.post('/api/login', json={'username': 'admin', 'password': 'wrong'}).status_code == 401
        assert client.post('/api/login', json={'username': 'admin', 'password': 'test-password'}).status_code == 200
        assert 'httponly' in client.cookies.__repr__().lower() or client.get('/api/me').status_code == 200
        assert client.get('/api/tracks?sort=played').json()['total'] == 0
        assert client.get('/api/tracks?q=source').json()['total'] == 1
        response = client.get(f'/api/tracks/{track_id}/stream', headers={'Range': 'bytes=20-219'})
        assert response.status_code == 206
        assert response.headers['content-range'].startswith('bytes 20-219/')
        assert response.content == source.read_bytes()[20:220]
        assert client.get(f'/api/tracks/{track_id}/stream', headers={'Range': 'bytes=99999999-'}).status_code == 416
        head = client.head(f'/api/tracks/{track_id}/stream')
        assert head.status_code == 200 and int(head.headers['content-length']) == source.stat().st_size
        p = client.post('/api/playlists', json={'name':'Test','track_ids':[track_id]}).json()
        updated = client.put('/api/playlists/'+p['id'], json={'name':'Renamed','track_ids':[], 'expected_revision':0}).json()
        assert updated['tracks'] == [] and updated['revision'] > 0
        assert client.put('/api/playlists/'+p['id'], json={'name':'Stale','track_ids':[], 'expected_revision':0}).status_code == 409
        undone = client.post('/api/playlists/'+p['id']+'/undo').json()
        assert undone['name'] == 'Test' and len(undone['tracks']) == 1
        assert client.post('/api/scan', json={'folder':'../escape'}).status_code == 400
        assert client.post('/api/scan', json={'folder':''}, headers={'Origin':'https://evil.invalid'}).status_code == 403
        assert client.get('/api/covers/not-a-cover.jpg').status_code == 404
        assert client.get('/api/settings').json().get('DEEPSEEK_API_KEY') is None
        client.post('/api/logout')
        assert client.get('/api/me').status_code == 401


def test_missing_root_does_not_remove_index(library):
    wav(library/'Album'/'source.wav')
    scanner.scan()
    moved = library.with_name('unmounted')
    library.rename(moved)
    assert not scanner.scan()
    assert len(all_tracks()) == 1


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg not installed')
def test_lossless_transcode_preserves_pcm_and_cue_boundaries(library):
    source = wav(library/'Album'/'source.wav', 4)
    cue = library/'Album'/'source.cue'
    cue.write_text('TITLE "Album"\nFILE "source.wav" WAVE\n TRACK 01 AUDIO\n TITLE "One"\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n TITLE "Two"\n INDEX 01 00:02:00\n',encoding='utf-8')
    scanner.scan()
    virtual = all_tracks()[1]
    with TestClient(app) as client:
        client.post('/api/login', json={'username':'admin','password':'test-password'})
        response = client.get(f"/api/tracks/{virtual['id']}/stream?quality=original")
        assert response.status_code == 200 and response.headers['content-type'] == 'audio/flac'
        pcm = subprocess.run(['ffmpeg','-v','error','-i','pipe:0','-f','s16le','-c:a','pcm_s16le','pipe:1'],
            input=response.content,capture_output=True,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        assert pcm.returncode == 0
        with wave.open(str(source),'rb') as f:
            f.setpos(44100*2)
            expected = f.readframes(44100*2)
        assert len(pcm.stdout) == 44100*2*4
        assert hashlib.sha256(pcm.stdout).digest() == hashlib.sha256(expected).digest()
