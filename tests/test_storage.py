import asyncio

import httpx
from starlette.requests import Request

from backend import storage


def request(ip='192.168.0.50', scheme='http', method='GET', headers=None):
    return Request({'type':'http','method':method,'scheme':scheme,'path':'/api/stream',
                    'query_string':b'','server':('music.test',8765),'client':(ip,1234),
                    'headers':headers or []})


def test_network_route_selection(monkeypatch):
    monkeypatch.setenv('WEBDAV_MUSIC_PATH','')
    monkeypatch.setenv('WEBDAV_MODE','auto')
    monkeypatch.setenv('PUBLIC_HTTPS','false')
    monkeypatch.setenv('WEBDAV_LAN_URL','http://192.168.0.233:12307/dav')
    monkeypatch.setenv('WEBDAV_HTTP_URL','http://ddns.test:12307/dav')
    monkeypatch.setenv('WEBDAV_HTTPS_URL','https://dav.test:1443/dav')
    assert storage.dav_urls(request())[0]=='http://192.168.0.233:12307/dav'
    assert storage.dav_urls(request('8.8.8.8'))[0]=='http://ddns.test:12307/dav'
    assert storage.dav_urls(request('8.8.8.8','https'))==['https://dav.test:1443/dav']
    monkeypatch.setenv('PUBLIC_HTTPS','true')
    assert storage.dav_urls(request())==['https://dav.test:1443/dav']
    monkeypatch.setenv('WEBDAV_MUSIC_PATH','PC/Music')
    assert storage.dav_urls(request())==['https://dav.test:1443/dav/PC/Music']


def test_webdav_range_stream_and_credentials_stay_server_side(monkeypatch):
    monkeypatch.setenv('WEBDAV_MUSIC_PATH','')
    monkeypatch.setenv('WEBDAV_USERNAME','test-user')
    monkeypatch.setenv('WEBDAV_PASSWORD','test-only-password')
    monkeypatch.setenv('WEBDAV_MODE','https')
    monkeypatch.setenv('WEBDAV_HTTPS_URL','https://dav.test/dav')
    observed=[]
    async def handler(req):
        observed.append(req)
        assert req.headers['range']=='bytes=10-13'
        assert req.headers['accept-encoding']=='identity'
        assert req.headers['authorization'].startswith('Basic ')
        assert req.url.path=='/dav/艺术家/专辑/01 track.flac'
        return httpx.Response(206,headers={'content-range':'bytes 10-13/100','content-length':'4',
                                         'accept-ranges':'bytes'},stream=httpx.ByteStream(b'FLAC'))
    original=httpx.AsyncClient
    monkeypatch.setattr(storage.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    async def run():
        response=await storage.dav_stream({'path':'艺术家/专辑/01 track.flac'},
             request(headers=[(b'range',b'bytes=10-13')]),'audio/flac')
        content=b''.join([part async for part in response.body_iterator])
        assert response.status_code==206 and content==b'FLAC'
        assert response.headers['content-range']=='bytes 10-13/100'
        assert 'authorization' not in response.headers
    asyncio.run(run())
    assert len(observed)==1
