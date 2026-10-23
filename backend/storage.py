import ipaddress
import os
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from starlette.responses import Response, StreamingResponse

from . import config


def dav_urls(request=None):
    mode = os.getenv('WEBDAV_MODE', 'auto')
    if mode == 'https' or config.flag('PUBLIC_HTTPS') or (request and request.url.scheme == 'https'):
        names = ['WEBDAV_HTTPS_URL']
    elif mode == 'http':
        names = ['WEBDAV_HTTP_URL']
    else:
        local = True
        if request and request.client:
            try:
                address = ipaddress.ip_address(request.client.host)
                local = address.is_private or address.is_loopback
            except ValueError:
                pass
        names = ['WEBDAV_LAN_URL', 'WEBDAV_HTTPS_URL'] if local else ['WEBDAV_HTTP_URL', 'WEBDAV_HTTPS_URL']
    prefix = os.getenv('WEBDAV_MUSIC_PATH', '').strip('/')
    suffix = '/' + quote(prefix, safe='/') if prefix else ''
    return list(dict.fromkeys(os.getenv(name, '').rstrip('/') + suffix for name in names if os.getenv(name)))


async def dav_stream(track, request, mime):
    if not os.getenv('WEBDAV_USERNAME') or not os.getenv('WEBDAV_PASSWORD'):
        raise HTTPException(404, '本地音源不可访问，且未配置 WebDAV')
    headers = {'Accept-Encoding': 'identity'}
    if request:
        for key in ('range', 'if-range'):
            if value := request.headers.get(key):
                headers[key] = value
    method = 'HEAD' if request and request.method == 'HEAD' else 'GET'
    for base in dav_urls(request):
        client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=8), follow_redirects=True, max_redirects=5,
                                  auth=(os.getenv('WEBDAV_USERNAME'), os.getenv('WEBDAV_PASSWORD')))
        try:
            url = base + '/' + quote(track['path'].replace('\\', '/'), safe='/')
            upstream = await client.send(client.build_request(method, url, headers=headers), stream=True)
            if upstream.status_code not in (200, 206, 416):
                await upstream.aclose()
                await client.aclose()
                continue
        except httpx.HTTPError:
            await client.aclose()
            continue
        forwarded = {key: upstream.headers[key] for key in ('content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified') if key in upstream.headers}
        forwarded.update({'Cache-Control': 'private, max-age=3600', 'X-Audio-Mode': 'webdav-original'})
        if method == 'HEAD' or upstream.status_code == 416:
            status = upstream.status_code
            await upstream.aclose()
            await client.aclose()
            return Response(status_code=status, headers=forwarded, media_type=mime)

        async def chunks(response=upstream, owner=client):
            try:
                async for chunk in response.aiter_raw(65536):
                    yield chunk
            finally:
                await response.aclose()
                await owner.aclose()
        return StreamingResponse(chunks(), status_code=upstream.status_code, media_type=mime, headers=forwarded)
    raise HTTPException(404, '本地及 WebDAV 均无法读取此音源，请检查文件位置或连接')
