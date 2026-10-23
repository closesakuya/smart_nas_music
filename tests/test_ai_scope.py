import asyncio
import json

from backend import ai, db, scanner
from tests.test_library import library, wav


def test_scope_is_enforced_even_for_fallback_and_playlist_context(library, monkeypatch):
    for folder in ('A_100%/Album', 'A_100%/Album/Sub', 'AX100x/Other', 'Other'):
        wav(library / folder / 'song.wav')
    scanner.scan()
    with db.connect() as conn:
        conn.execute("UPDATE tracks SET album='Same name',album_artist=CASE WHEN folder='Other' THEN 'Other artist' ELSE 'Chosen artist' END")
        rows = [dict(r) for r in conn.execute('SELECT * FROM tracks')]
        conn.execute("INSERT INTO playlists(id,name) VALUES('p','old playlist')")
        conn.executemany('INSERT INTO playlist_tracks VALUES(?,?,?)', [('p', r['id'], i) for i, r in enumerate(rows)])
    all_ids = [r['id'] for r in rows]
    captured = []
    async def complete(messages, kind):
        if kind == 'search-plan':
            return {'terms': ['no-match-ever'], 'folders': []}
        candidates = json.loads(messages[0]['content'].split('。候选曲目数据：')[1])
        captured.append({r['id'] for r in candidates})
        return {'track_ids': all_ids, 'action': 'suggest', 'message': '推荐'}
    monkeypatch.setattr(ai, 'complete', complete)
    cases = [
        ({'kind': 'folder', 'folder': 'A_100%/Album'}, {r['id'] for r in rows if r['folder'].startswith('A_100%/Album')}),
        ({'kind': 'album', 'album': 'Same name', 'album_artist': 'Other artist'}, {r['id'] for r in rows if r['folder'] == 'Other'}),
        ({'kind': 'library'}, set(all_ids)),
    ]
    for scope, expected in cases:
        result = asyncio.run(ai.recommend('换一些音乐', [], 'p', scope))
        assert {t['id'] for t in result['tracks']} == expected
        assert captured[-1] == expected
    result = asyncio.run(ai.recommend('新歌', [], None, {'kind': 'library'}, all_ids))
    assert result['tracks'] == []
    assert result['action'] == 'suggest'
