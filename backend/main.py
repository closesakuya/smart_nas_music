import asyncio
import hashlib
import json
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal

from . import ai, config, scanner, similar
from .audio import stream_track
from .db import connect, init, track_dict
from .storage import dav_urls

login_attempts = {}
ai_chat_limit = asyncio.Semaphore(2)
tasks = set()


@asynccontextmanager
async def lifespan(app):
    if not config.PASSWORD or config.PASSWORD == 'change-me':
        raise RuntimeError('请在 .env 设置 APP_PASSWORD 后启动')
    init()
    observer, worker = scanner.start_watcher()
    yield
    scanner.shutdown.set()
    observer.stop()
    await asyncio.to_thread(worker.join, 8)
    for task in list(tasks):
        task.cancel()


app = FastAPI(title='Summer Music', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def access(request: Request, call_next):
    path = request.url.path
    if path.startswith('/api/') and path not in ('/api/login', '/api/health'):
        token = hashlib.sha256(request.cookies.get('summer_session', '').encode()).hexdigest()
        with connect() as db:
            session = db.execute('SELECT expires FROM sessions WHERE token=?', (token,)).fetchone()
        if not session or session['expires'] < time.time():
            return JSONResponse({'detail': '请先登录'}, status_code=401)
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if origin and urlparse(origin).netloc != request.headers.get('host'):
            return JSONResponse({'detail': '请求来源不匹配'}, status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['X-Frame-Options'] = 'DENY'
    if path.startswith('/api/') and '/stream' not in path and '/covers/' not in path:
        response.headers['Cache-Control'] = 'no-store'
    return response


class Login(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=500)


@app.get('/api/health')
def health():
    return {'status': 'ok', 'version': '0.1.0'}


@app.post('/api/login')
def login(body: Login, request: Request):
    ip = request.client.host if request.client else 'local'
    now = time.time()
    recent = [t for t in login_attempts.get(ip, []) if now-t < 60]
    if len(recent) >= 10:
        raise HTTPException(429, '尝试过于频繁，请一分钟后重试')
    login_attempts[ip] = recent + [now]
    if not (secrets.compare_digest(body.username.encode(), config.USERNAME.encode()) and
            secrets.compare_digest(body.password.encode(), config.PASSWORD.encode())):
        raise HTTPException(401, '用户名或密码不正确')
    token = secrets.token_urlsafe(40)
    hours = min(720, max(1, int(os.getenv('SESSION_HOURS', '168'))))
    with connect() as db:
        db.execute('DELETE FROM sessions WHERE expires<?', (now,))
        db.execute('INSERT INTO sessions VALUES(?,?)', (hashlib.sha256(token.encode()).hexdigest(), now + hours*3600))
    response = JSONResponse({'username': config.USERNAME})
    response.set_cookie('summer_session', token, httponly=True, samesite='strict',
                        secure=config.flag('COOKIE_SECURE'), max_age=hours*3600)
    return response


@app.get('/api/me')
def me():
    return {'username': config.USERNAME}


@app.post('/api/logout')
def logout(request: Request):
    token = hashlib.sha256(request.cookies.get('summer_session', '').encode()).hexdigest()
    with connect() as db:
        db.execute('DELETE FROM sessions WHERE token=?', (token,))
    response = JSONResponse({'ok': True})
    response.delete_cookie('summer_session')
    return response


@app.get('/api/stats')
def stats():
    with connect() as db:
        total = dict(db.execute('''SELECT count(*) tracks,count(DISTINCT album||'|'||album_artist) albums,
          count(DISTINCT artist) artists,coalesce(sum(duration),0) duration,
          coalesce(sum(favorite),0) favorites FROM tracks WHERE available=1 AND hidden=0''').fetchone())
        total['formats'] = [dict(r) for r in db.execute('SELECT format,count(*) count FROM tracks WHERE available=1 AND hidden=0 GROUP BY format ORDER BY count DESC')]
        total['last_scan'] = dict(r) if (r := db.execute('SELECT * FROM scans ORDER BY id DESC LIMIT 1').fetchone()) else None
        total['ai_usage'] = dict(db.execute("SELECT count(*) requests,coalesce(sum(input_tokens),0) input_tokens,coalesce(sum(output_tokens),0) output_tokens FROM ai_usage WHERE date(created_at)=date('now')").fetchone())
    total.update(ai_configured=bool(os.getenv('DEEPSEEK_API_KEY')), scan=dict(scanner.state), tags=dict(ai.tag_state))
    return total


def like_escape(value):
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


@app.get('/api/tracks')
def tracks(q: str = '', folder: str | None = None, album: str | None = None,
           artist: str | None = None, album_artist: str | None = None, favorite: bool = False, sort: str = 'folder',
           limit: int = 100, offset: int = 0):
    clauses, args = ['available=1', 'hidden=0'], []
    if q.strip():
        clauses.append("(title||' '||artist||' '||album||' '||genre||' '||folder||' '||ai_tags||' '||metadata) LIKE ? ESCAPE '\\'")
        args.append('%' + like_escape(q.strip()[:300]) + '%')
    if folder is not None:
        clauses.append("(folder=? OR folder LIKE ? ESCAPE '\\')")
        args += [folder, like_escape(folder) + '/%']
    if album is not None:
        clauses.append('album=?')
        args.append(album)
    if artist is not None:
        clauses.append('artist=?')
        args.append(artist)
    if album_artist is not None:
        clauses.append('album_artist=?')
        args.append(album_artist)
    if favorite:
        clauses.append('favorite=1')
    if sort == 'played':
        clauses.append('last_played IS NOT NULL')
    order = {'folder': 'folder COLLATE NOCASE,disc_no,track_no,title',
             'recent': 'added_at DESC,rowid DESC', 'played': 'last_played DESC',
             'title': 'title COLLATE NOCASE', 'random': 'random()'}.get(sort, 'folder,disc_no,track_no,title')
    where = ' AND '.join(clauses)
    with connect() as db:
        count = db.execute('SELECT count(*) FROM tracks WHERE ' + where, args).fetchone()[0]
        rows = db.execute('SELECT * FROM tracks WHERE ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?',
                          [*args, min(300, max(1, limit)), max(0, offset)]).fetchall()
    return {'items': [track_dict(r) for r in rows], 'total': count}


@app.get('/api/folders')
def folders(parent: str = ''):
    with connect() as db:
        rows = db.execute('SELECT folder,count(*) count,min(cover) cover FROM tracks WHERE available=1 AND hidden=0 GROUP BY folder').fetchall()
    prefix = parent + '/' if parent else ''
    result = {}
    for row in rows:
        if not row['folder'].startswith(prefix):
            continue
        rest = row['folder'][len(prefix):]
        if not rest or rest == '.':
            continue
        name = rest.split('/')[0]
        item = result.setdefault(name, {'name': name, 'path': prefix+name, 'count': 0, 'cover': None})
        item['count'] += row['count']
        item['cover'] = item['cover'] or row['cover']
    return sorted(result.values(), key=lambda f: f['name'].lower())


@app.get('/api/albums')
def albums(q: str = '', offset: int = 0, limit: int = 60, sort: str = 'recent'):
    with connect() as db:
        order = 'random()' if sort == 'random' else 'max(added_at) DESC,album'
        rows = db.execute('''SELECT album,album_artist,coalesce(nullif(album_artist,''),artist) artist,
          min(cover) cover,count(*) count,sum(duration) duration,min(year) year
          FROM tracks WHERE available=1 AND hidden=0 AND (album||' '||artist) LIKE ? ESCAPE '\\'
          GROUP BY album,album_artist ORDER BY ''' + order + ' LIMIT ? OFFSET ?',
                          ('%'+like_escape(q[:300])+'%', min(120, max(1, limit)), max(0, offset))).fetchall()
    return [dict(r) for r in rows]


def get_track(track_id):
    with connect() as db:
        row = db.execute('SELECT * FROM tracks WHERE id=?', (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, '歌曲不存在')
    return track_dict(row)


@app.get('/api/tracks/{track_id}/lyrics')
def track_lyrics(track_id: str):
    from .lyrics import read_lyrics
    return read_lyrics(get_track(track_id))


@app.get('/api/tracks/{track_id}')
def track(track_id: str):
    return get_track(track_id)


@app.api_route('/api/tracks/{track_id}/stream', methods=['GET', 'HEAD'])
async def stream(track_id: str, request: Request, quality: str = 'original'):
    return await stream_track(get_track(track_id), quality, request)


@app.get('/api/covers/{name}')
def cover(name: str):
    if not (len(name) == 36 and name.endswith('.jpg') and all(c in '0123456789abcdef' for c in name[:-4])):
        raise HTTPException(404)
    path = config.DATA / 'covers' / name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers={'Cache-Control': 'private, max-age=604800'})


class Favorite(BaseModel):
    favorite: bool


@app.put('/api/tracks/{track_id}/favorite')
def favorite(track_id: str, body: Favorite):
    get_track(track_id)
    with connect() as db:
        db.execute('UPDATE tracks SET favorite=? WHERE id=?', (int(body.favorite), track_id))
    return {'favorite': body.favorite}


@app.post('/api/tracks/{track_id}/played')
def played(track_id: str):
    get_track(track_id)
    with connect() as db:
        db.execute('INSERT INTO history(track_id) VALUES(?)', (track_id,))
        db.execute('UPDATE tracks SET plays=plays+1,last_played=CURRENT_TIMESTAMP WHERE id=?', (track_id,))
    return {'ok': True}


class PlaylistBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default='', max_length=2000)
    track_ids: list[str] = Field(default_factory=list, max_length=10000)
    expected_revision: int | None = None


def playlist_detail(playlist_id, db):
    row = db.execute('SELECT * FROM playlists WHERE id=?', (playlist_id,)).fetchone()
    if not row:
        raise HTTPException(404, '歌单不存在')
    result = dict(row)
    result['tracks'] = [track_dict(r) for r in db.execute('''SELECT t.* FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id
      WHERE p.playlist_id=? ORDER BY p.position''', (playlist_id,))]
    result['revision'] = db.execute('SELECT coalesce(max(id),0) FROM playlist_revisions WHERE playlist_id=?', (playlist_id,)).fetchone()[0]
    return result


def write_playlist(db, playlist_id, body):
    ids = list(dict.fromkeys(body.track_ids))
    if ids:
        valid = {r[0] for r in db.execute('SELECT id FROM tracks WHERE id IN (' + ','.join('?' for _ in ids) + ')', ids)}
        if len(valid) != len(ids):
            raise HTTPException(422, '歌单包含不存在的歌曲')
    db.execute('DELETE FROM playlist_tracks WHERE playlist_id=?', (playlist_id,))
    db.executemany('INSERT INTO playlist_tracks VALUES(?,?,?)', [(playlist_id, t, i) for i, t in enumerate(ids)])
    db.execute('UPDATE playlists SET name=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', (body.name.strip(), body.description, playlist_id))


@app.get('/api/playlists')
def playlists():
    with connect() as db:
        return [dict(r) for r in db.execute('''SELECT p.*,count(pt.track_id) count,min(t.cover) cover
          FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id
          LEFT JOIN tracks t ON t.id=pt.track_id GROUP BY p.id ORDER BY p.updated_at DESC''')]


@app.post('/api/playlists')
def create_playlist(body: PlaylistBody):
    with connect() as db:
        playlist_id = uuid.uuid4().hex
        db.execute('INSERT INTO playlists(id,name,description) VALUES(?,?,?)', (playlist_id, body.name.strip(), body.description))
        write_playlist(db, playlist_id, body)
        return playlist_detail(playlist_id, db)


@app.get('/api/playlists/{playlist_id}')
def playlist(playlist_id: str):
    with connect() as db:
        return playlist_detail(playlist_id, db)


@app.put('/api/playlists/{playlist_id}')
def update_playlist(playlist_id: str, body: PlaylistBody):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        snapshot = playlist_detail(playlist_id, db)
        if body.expected_revision is not None and body.expected_revision != snapshot['revision']:
            raise HTTPException(409, '歌单已更新，请刷新后重试')
        db.execute('INSERT INTO playlist_revisions(playlist_id,snapshot) VALUES(?,?)', (playlist_id, json.dumps(snapshot, ensure_ascii=False)))
        write_playlist(db, playlist_id, body)
        return playlist_detail(playlist_id, db)


@app.post('/api/playlists/{playlist_id}/undo')
def undo_playlist(playlist_id: str):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        playlist_detail(playlist_id, db)
        row = db.execute('SELECT * FROM playlist_revisions WHERE playlist_id=? ORDER BY id DESC LIMIT 1', (playlist_id,)).fetchone()
        if not row:
            raise HTTPException(409, '没有可撤销的修改')
        snapshot = json.loads(row['snapshot'])
        write_playlist(db, playlist_id, PlaylistBody(name=snapshot['name'], description=snapshot['description'],
                                                    track_ids=[t['id'] for t in snapshot['tracks']]))
        db.execute('DELETE FROM playlist_revisions WHERE id=?', (row['id'],))
        return playlist_detail(playlist_id, db)


@app.delete('/api/playlists/{playlist_id}')
def delete_playlist(playlist_id: str):
    with connect() as db:
        db.execute('DELETE FROM playlist_revisions WHERE playlist_id=?', (playlist_id,))
        db.execute('DELETE FROM playlists WHERE id=?', (playlist_id,))
    return {'ok': True}


class ScanBody(BaseModel):
    folder: str = Field(default='', max_length=1500)


@app.post('/api/scan')
def scan(body: ScanBody):
    try:
        scanner.request_scan(body.folder)
    except ValueError:
        raise HTTPException(400, '扫描路径无效')
    return {'queued': True}


class RecommendationScope(BaseModel):
    kind: Literal['library', 'album', 'folder', 'favorites', 'playlist', 'recent'] = 'library'
    album: str = Field(default='', max_length=500)
    album_artist: str = Field(default='', max_length=500)
    folder: str = Field(default='', max_length=2000)
    playlist_id: str = Field(default='', max_length=100)


class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict] = Field(default_factory=list, max_length=16)
    playlist_id: str | None = None
    scope: RecommendationScope = Field(default_factory=RecommendationScope)
    exclude_ids: list[str] = Field(default_factory=list, max_length=150)


@app.post('/api/ai/chat')
async def chat(body: ChatBody):
    history = [{'role': h['role'], 'content': str(h.get('content', ''))[:3000]} for h in body.history
               if h.get('role') in ('user', 'assistant')]
    async with ai_chat_limit:
        return await ai.recommend(body.message, history, body.playlist_id, body.scope.model_dump(), body.exclude_ids)


class SimilarBody(BaseModel):
    seed_ids: list[str] = Field(min_length=1, max_length=150)
    online: bool = False


@app.post('/api/ai/similar')
async def similar_tracks(body: SimilarBody):
    async with ai_chat_limit:
        return await similar.recommend(body.seed_ids, body.online)


class TagsBody(BaseModel):
    track_ids: list[str] = Field(default_factory=list, max_length=240)


@app.post('/api/ai/tags')
async def tags(body: TagsBody):
    if ai.tag_state['running']:
        raise HTTPException(409, '标签任务正在运行')
    if not os.getenv('DEEPSEEK_API_KEY'):
        raise HTTPException(503, '请配置 DeepSeek API Key')
    ids = list(dict.fromkeys(body.track_ids))
    if not ids:
        with connect() as db:
            ids = [r[0] for r in db.execute("SELECT id FROM tracks WHERE available=1 AND hidden=0 AND ai_tags='{}' LIMIT 60")]
    ai.tag_state['running'] = True
    task = asyncio.create_task(ai.tag_batch(ids))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {'queued': len(ids)}


@app.post('/api/tracks/{track_id}/online')
async def online(track_id: str):
    return await ai.online_metadata(get_track(track_id))


@app.get('/api/settings')
def settings():
    return {'music_root': str(config.ROOT), 'ai_model': os.getenv('DEEPSEEK_MODEL', 'deepseek-flash'),
            'ai_configured': bool(os.getenv('DEEPSEEK_API_KEY')),
            'webdav_configured': bool(os.getenv('WEBDAV_USERNAME') and os.getenv('WEBDAV_PASSWORD')),
            'public_https': config.flag('PUBLIC_HTTPS'), 'cookie_secure': config.flag('COOKIE_SECURE'),
            'cache_limit_gb': float(os.getenv('TRANSCODE_CACHE_GB', '10')),
            'ai_daily_limit': int(os.getenv('AI_DAILY_REQUEST_LIMIT', '200'))}


@app.post('/api/webdav/check')
async def dav_check(request: Request):
    # WebDAV is server-side only. Playback uses the co-located source directory.
    urls = dav_urls(request)
    root_reachable = False
    with connect() as db:
        sample = db.execute('SELECT path FROM tracks WHERE available=1 AND cue_path IS NULL LIMIT 1').fetchone()
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        for url in dict.fromkeys(urls):
            if not url:
                continue
            try:
                response = await client.request('PROPFIND', url.rstrip('/') + '/', headers={'Depth': '0'},
                    auth=(os.getenv('WEBDAV_USERNAME', ''), os.getenv('WEBDAV_PASSWORD', '')))
                if response.status_code in (200, 207):
                    root_reachable = True
                    if sample:
                        from urllib.parse import quote
                        probe = await client.head(url.rstrip('/') + '/' + quote(sample['path'], safe='/'),
                            auth=(os.getenv('WEBDAV_USERNAME', ''), os.getenv('WEBDAV_PASSWORD', '')))
                        if probe.status_code not in (200, 206, 301, 302, 307, 308):
                            continue
                    return {'ok': True, 'mode': 'lan' if url.startswith(os.getenv('WEBDAV_LAN_URL', '\0')) else 'remote',
                            'file_verified': bool(sample)}
            except httpx.HTTPError:
                continue
    if root_reachable:
        raise HTTPException(502, 'WebDAV 目录可连接，但音乐路径未匹配。请设置 WEBDAV_MUSIC_PATH 为音乐挂载子目录')
    raise HTTPException(502, 'WebDAV 不可连接；本地目录播放不受影响')


dist = config.BASE / 'frontend' / 'dist'
if dist.is_dir():
    app.mount('/', StaticFiles(directory=dist, html=True), name='frontend')
