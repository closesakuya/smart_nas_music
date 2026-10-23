import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from backend import ai, db, scanner, similar
from tests.test_library import library, wav


def seed_library(root):
    wav(root / 'Seeds' / 'seed.wav')
    wav(root / 'Other' / 'other.wav')
    scanner.scan()
    with db.connect() as conn:
        rows = conn.execute('SELECT id FROM tracks ORDER BY folder DESC').fetchall()
        conn.execute("UPDATE tracks SET title='Owned Song',artist='Owned Artist' WHERE id=?", (rows[0][0],))
    return [r[0] for r in rows]


def test_local_similarity_is_library_only_and_never_searches_web(library, monkeypatch):
    ids = seed_library(library)
    called = []
    async def recommend(message, history, **kwargs):
        called.append(kwargs)
        assert 'Owned Song' in message
        return {'tracks': [{'id': ids[1]}], 'message': '相似', 'action': 'replace'}
    async def forbidden(*args):
        raise AssertionError('Unchecked web search must not call network search')
    monkeypatch.setattr(ai, 'recommend', recommend)
    monkeypatch.setattr(similar, 'search_web', forbidden)
    result = asyncio.run(similar.recommend([ids[0], ids[0]]))
    assert result['source'] == 'library' and result['action'] == 'suggest'
    assert result['external_tracks'] == [] and result['seed_count'] == 1
    assert called[0]['scope'] == {'kind': 'library'} and called[0]['exclude_ids'] == [ids[0]]


def test_online_filters_owned_unsupported_and_unreferenced_records(library, monkeypatch):
    ids = seed_library(library)
    async def search(query):
        return [{'title': 'Discography', 'url': 'https://music.example.com/catalog',
                 'text': 'New Artist recorded New Song for New Album. Owned Artist recorded Owned Song.'}]
    async def complete(messages, kind):
        if kind == 'similar-web-plan':
            return {'queries': ['similar music']}
        return {'songs': [
            {'title': 'New Song', 'artist': 'New Artist', 'album': 'New Album', 'reason': 'Similar style', 'source_indices': [0]},
            {'title': 'Owned Song', 'artist': 'Owned Artist', 'source_indices': [0]},
            {'title': 'Invented Song', 'artist': 'Invented Artist', 'source_indices': [0]},
            {'title': 'New Song', 'artist': 'New Artist', 'source_indices': [99]},
        ]}
    monkeypatch.setattr(similar, 'search_web', search)
    monkeypatch.setattr(ai, 'complete', complete)
    result = asyncio.run(similar.recommend([ids[0]], True))
    assert result['tracks'] == [] and result['source'] == 'web'
    assert len(result['external_tracks']) == 1
    song = result['external_tracks'][0]
    assert song['title'] == 'New Song' and song['album'] == 'New Album' and song['playable'] is False
    assert 'id' not in song and 'path' not in song
    assert song['sources'][0]['url'] == 'https://music.example.com/catalog'


def test_search_uses_real_api_and_cache_and_never_fabricates_on_failure(library, monkeypatch):
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-key-not-real')
    monkeypatch.setenv('DEEPSEEK_SEARCH_BASE_URL', 'https://api.deepseek.com')
    requests = []
    def handler(request):
        requests.append(request)
        assert request.url.path == '/v1/tools/search'
        assert json.loads(request.content)['need_content'] is True
        return httpx.Response(200, json={'results': [
            {'url': 'https://music.example.com/album', 'title': 'Album', 'summary': 'Artist Song'},
            {'url': 'javascript:alert(1)', 'title': 'malicious'},
            {'url': 'http://127.0.0.1/private', 'title': 'private'},
        ]})
    original_client = httpx.AsyncClient
    monkeypatch.setattr(similar.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    assert len(asyncio.run(similar.search_web('new songs'))) == 1
    assert len(asyncio.run(similar.search_web('new songs'))) == 1
    assert len(requests) == 1
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM ai_usage WHERE kind='web-search'").fetchone()[0] == 1
    monkeypatch.setattr(similar.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(lambda req: httpx.Response(402)), **kwargs))
    with pytest.raises(HTTPException, match='网络搜索返回'):
        asyncio.run(similar.search_web('another query'))


def test_invalid_reference_rejected(library):
    with pytest.raises(HTTPException) as error:
        asyncio.run(similar.recommend(['missing-id']))
    assert error.value.status_code == 422
