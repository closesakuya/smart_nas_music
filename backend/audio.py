import asyncio
import hashlib
import os
import shutil
import time
from pathlib import Path

from fastapi import HTTPException
from starlette.responses import FileResponse

from . import config
from .storage import dav_stream

semaphore = asyncio.Semaphore(2)
locks: dict[str, asyncio.Lock] = {}
MIME = {'flac': 'audio/flac', 'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'm4a': 'audio/mp4',
        'ogg': 'audio/ogg', 'opus': 'audio/ogg', 'aac': 'audio/aac', 'aiff': 'audio/aiff'}


def evict_cache(keep):
    folder = config.DATA / 'transcode'
    limit = int(float(os.getenv('TRANSCODE_CACHE_GB', '10')) * 1024**3)
    paths = [p for p in folder.iterdir() if p.suffix in ('.flac', '.mp3')]
    total = sum(p.stat().st_size for p in paths)
    for path in sorted(paths, key=lambda p: p.stat().st_mtime):
        if total <= limit:
            break
        if path == keep or time.time() - path.stat().st_mtime < 600:
            continue
        try:
            size = path.stat().st_size
            path.unlink()
            total -= size
        except OSError:
            pass


async def stream_track(track, quality='original', request=None):
    try:
        source = config.media_path(track['path'])
    except ValueError:
        raise HTTPException(400, '无效音源路径')
    fmt = source.suffix[1:].lower()
    if not source.is_file():
        if quality == 'original' and not track.get('cue_path'):
            return await dav_stream(track, request, MIME.get(fmt, 'application/octet-stream'))
        raise HTTPException(404, '本地音源暂不可访问；WebDAV 备用读取仅支持完整原音')
    headers = {'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff'}
    virtual = bool(track.get('cue_path'))
    if quality == 'original' and not virtual:
        return FileResponse(source, media_type=MIME.get(fmt, 'application/octet-stream'),
                            headers={**headers, 'X-Audio-Mode': 'original'},
                            filename=source.name, content_disposition_type='inline')
    if quality not in ('original', 'lossless', '320', '192', '128'):
        raise HTTPException(400, '不支持的音质')
    lossless = quality in ('original', 'lossless')
    extension = 'flac' if lossless else 'mp3'
    st = source.stat()
    key = hashlib.sha256(f"v1|{track['id']}|{st.st_mtime_ns}|{st.st_size}|{quality}|{track.get('start')}|{track.get('end')}".encode()).hexdigest()
    target = config.DATA / 'transcode' / f'{key}.{extension}'
    lock = locks.setdefault(key, asyncio.Lock())
    async with lock:
        if not target.exists():
            binary = shutil.which(config.FFMPEG)
            if not binary:
                raise HTTPException(503, 'FFmpeg 不可用，请配置 FFMPEG_PATH')
            async with semaphore:
                temporary = target.with_name(key + '.working.' + extension)
                cmd = [binary, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source)]
                if virtual:
                    cmd += ['-ss', str(track['start']), '-t', str(track['duration'])]
                cmd += ['-map', '0:a:0', '-vn', '-map_metadata', '-1']
                if lossless:
                    cmd += ['-c:a', 'flac', '-compression_level', '5']
                    # FLAC stores up to 24-bit PCM; do not silently truncate 32-bit PCM.
                    if track.get('bit_depth', 0) > 24:
                        raise HTTPException(422, '此源超过 FLAC 位深范围，请使用原音播放')
                else:
                    cmd += ['-c:a', 'libmp3lame', '-b:a', quality + 'k', '-ar', '44100', '-ac', '2']
                if fmt in ('dsf', 'dff'):
                    cmd += ['-ar', '88200' if lossless else '44100']
                cmd += [str(temporary)]
                process = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL,
                                                               stderr=asyncio.subprocess.PIPE)
                try:
                    _, error = await asyncio.wait_for(process.communicate(), timeout=600)
                    if process.returncode:
                        raise HTTPException(422, '当前音源转码失败，请尝试原音或其他音质')
                    os.replace(temporary, target)
                except BaseException:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                    temporary.unlink(missing_ok=True)
                    raise
    os.utime(target, None)
    evict_cache(target)
    return FileResponse(target, media_type=MIME[extension], headers={**headers, 'X-Audio-Mode': quality},
                        filename=f"{track['title']}.{extension}", content_disposition_type='inline')
