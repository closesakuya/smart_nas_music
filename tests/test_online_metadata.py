import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from backend import ai, similar
from tests.test_library import library


def test_web_extraction_disables_thinking_and_reports_truncation(library, monkeypatch):
    original = httpx.AsyncClient
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-only')
    def handler(request):
        assert json.loads(request.content)['thinking'] == {'type': 'disabled'}
        return httpx.Response(200, json={'choices': [{'finish_reason': 'length', 'message': {'content': '{"songs":['}}],
                                       'usage': {'prompt_tokens': 100, 'completion_tokens': 4096}})
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    with pytest.raises(HTTPException, match='AI 输出达到长度上限'):
        asyncio.run(ai.complete([{'role': 'user', 'content': 'JSON'}], 'similar-web-recommend'))


def test_metadata_timeout_falls_back_to_real_search(library, monkeypatch):
    original = httpx.AsyncClient
    def unavailable(request):
        raise httpx.ConnectTimeout('timeout', request=request)
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(unavailable), **kw))
    calls = []
    async def search(query):
        calls.append(query)
        return [{'title': 'Song source', 'url': 'https://example.com/song', 'text': 'Artist Song Album'}]
    monkeypatch.setattr(similar, 'search_web', search)
    result = asyncio.run(ai.online_metadata({'artist': 'Artist', 'title': 'Song', 'album': 'Album'}))
    assert calls == ['Artist Song Album 歌曲 专辑']
    assert result['source'] == 'web' and result['matches'] == []
    assert result['auto_applied'] is False and len(result['sources']) == 1


def test_metadata_reports_both_sources_unavailable(library, monkeypatch):
    original = httpx.AsyncClient
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(lambda r: httpx.Response(503)), **kw))
    async def search(query):
        raise HTTPException(502, '网络搜索暂不可用')
    monkeypatch.setattr(similar, 'search_web', search)
    with pytest.raises(HTTPException, match='MusicBrainz 连接失败；备用联网搜索'):
        asyncio.run(ai.online_metadata({'artist': 'Artist', 'title': 'Song', 'album': ''}))
