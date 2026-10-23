import hashlib
import io
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import mutagen
from charset_normalizer import from_bytes
from PIL import Image, ImageOps
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from . import config, db as database
from .db import connect

AUDIO = {'.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.ape', '.wv', '.tta', '.tak', '.dsf', '.dff', '.aiff', '.aif'}
SKIP = {'.git', '.agents', '.claude', '_logs', '_scripts', '_TMP', '_Videos', '_Originals_ToReview', 'node_modules', '__pycache__'}
COVER_NAMES = {'cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg'}
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp'}
cover_cache = {}
state = {'running': False, 'phase': '等待扫描', 'visited': 0, 'updated': 0, 'unchanged': 0,
         'missing': 0, 'errors': [], 'error_count': 0, 'started_at': None, 'finished_at': None}
scan_lock = threading.Lock()
pending_lock = threading.Lock()
pending: dict[str, float] = {}
shutdown = threading.Event()


def eligible(path: Path):
    try:
        parts = path.relative_to(config.ROOT).parts
        return not any(p in SKIP or p.startswith('.') for p in parts)
    except ValueError:
        return False


def identity(key):
    return hashlib.sha256(key.encode('utf-8')).hexdigest()[:24]


def first(tags, *keys, default=''):
    lowered = {str(k).lower(): v for k, v in (tags or {}).items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None:
            if isinstance(value, (list, tuple)):
                value = value[0] if value else ''
            return str(value)
    return default


def number(value):
    m = re.search(r'\d+', str(value))
    return int(m.group()) if m else 0


def professional_metadata(tags):
    fields = {
        'composer': ('composer', 'TCOM', '\xa9wrt'),
        'lyricist': ('lyricist', 'TEXT'), 'conductor': ('conductor', 'TPE3'),
        'performer': ('performer', 'TPE4'), 'language': ('language', 'TLAN'),
        'label': ('label', 'organization', 'TPUB'), 'isrc': ('isrc', 'TSRC'),
        'copyright': ('copyright', 'TCOP', 'cprt'), 'work': ('work', 'TIT1', '\xa9wrk'),
        'movement': ('movement', 'MVNM', '\xa9mvn'), 'movement_number': ('movementnumber', 'MVIN'),
        'bpm': ('bpm', 'TBPM', 'tmpo'), 'musical_key': ('initialkey', 'key', 'TKEY'),
        'track_total': ('tracktotal', 'totaltracks'), 'disc_total': ('disctotal', 'totaldiscs'),
        'original_date': ('originaldate', 'TDOR'), 'release_type': ('releasetype', 'musicbrainz_albumtype'),
        'replaygain_track_gain': ('replaygain_track_gain', 'TXXX:replaygain_track_gain'),
        'replaygain_album_gain': ('replaygain_album_gain', 'TXXX:replaygain_album_gain'),
        'musicbrainz_recording_id': ('musicbrainz_trackid', 'TXXX:MusicBrainz Track Id'),
        'musicbrainz_release_id': ('musicbrainz_albumid', 'TXXX:MusicBrainz Album Id'),
        'comment': ('comment', 'description', '\xa9cmt'), 'lyrics': ('lyrics', '\xa9lyr'),
    }
    return json.dumps({k: value for k, keys in fields.items() if (value := first(tags, *keys))}, ensure_ascii=False)


def cover_for(path, audio):
    blob = None
    if getattr(audio, 'pictures', None):
        pics = sorted(audio.pictures, key=lambda p: p.type != 3)
        blob = pics[0].data
    elif getattr(audio, 'tags', None):
        tags = audio.tags
        apic = getattr(tags, 'getall', lambda _: [])('APIC')
        if apic:
            blob = apic[0].data
        elif 'covr' in tags:
            blob = bytes(tags['covr'][0])
    if blob is None:
        for folder in (path.parent, path.parent.parent):
            if not folder.is_relative_to(config.ROOT):
                continue
            try:
                if folder in cover_cache:
                    key = cover_cache[folder]
                    if key:
                        return key
                    continue
                pictures = {p.name.lower(): p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT}
                ordered = list(dict.fromkeys(['cover.jpg', 'cover.png', 'cover.jpeg', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', *sorted(pictures)]))
                for name in ordered:
                    if name in pictures:
                        image = pictures[name]
                        if image.stat().st_size < 30_000_000:
                            blob = image.read_bytes()
                            break
            except OSError:
                continue
            if blob:
                break
            cover_cache[folder] = None
    if not blob:
        return None
    key = hashlib.sha256(blob).hexdigest()[:32] + '.jpg'
    target = config.DATA / 'covers' / key
    if not target.exists():
        try:
            with Image.open(io.BytesIO(blob)) as image:
                image = ImageOps.exif_transpose(image).convert('RGB')
                image.thumbnail((900, 900))
                image.save(target, 'JPEG', quality=87)
        except (OSError, ValueError, Image.DecompressionBombError):
            return None
    if 'folder' in locals():
        cover_cache[folder] = key
    return key


def extract(path):
    try:
        return extract_mutagen(path)
    except Exception as original:
        try:
            result = subprocess.run([config.FFPROBE, '-v', 'error', '-show_format', '-show_streams',
                '-of', 'json', str(path)], capture_output=True, timeout=25,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode:
                raise ValueError('ffprobe 无法解析')
            data = json.loads(result.stdout)
            stream = next(s for s in data['streams'] if s.get('codec_type') == 'audio')
            tags = {**data.get('format', {}).get('tags', {}), **stream.get('tags', {})}
            relative = path.relative_to(config.ROOT).as_posix()
            return dict(id=identity(relative), path=relative, folder=path.parent.relative_to(config.ROOT).as_posix(),
                title=first(tags, 'title') or path.stem, artist=first(tags, 'artist'),
                album_artist=first(tags, 'album_artist', 'albumartist'), album=first(tags, 'album') or path.parent.name,
                genre=first(tags, 'genre'), year=first(tags, 'date', 'year'),
                track_no=number(first(tags, 'track')), disc_no=number(first(tags, 'disc')),
                duration=float(stream.get('duration') or data.get('format', {}).get('duration', 0)),
                format=path.suffix[1:].upper(), sample_rate=int(stream.get('sample_rate') or 0),
                bit_depth=int(stream.get('bits_per_raw_sample') or stream.get('bits_per_sample') or 0),
                bitrate=int(stream.get('bit_rate') or data.get('format', {}).get('bit_rate', 0) or 0),
                channels=int(stream.get('channels') or 0), cover=cover_for(path, None),
                tags=json.dumps({**tags, '_parser': 'ffprobe'}, ensure_ascii=False), metadata=professional_metadata(tags))
        except Exception:
            raise original


def extract_mutagen(path):
    audio = mutagen.File(path)
    if audio is None:
        raise ValueError('无法识别的音频格式')
    tags = getattr(audio, 'tags', {}) or {}
    common = tags
    info = audio.info
    relative = path.relative_to(config.ROOT).as_posix()
    raw = {str(k): str(v)[:4000] for k, v in tags.items()
           if not str(k).lower().startswith(('apic', 'covr', 'metadata_block_picture'))}
    title = first(common, 'title', 'TIT2', '\xa9nam') or re.sub(r'^\d{1,3}\s*[-._ ]\s*', '', path.stem)
    return dict(id=identity(relative), path=relative, folder=path.parent.relative_to(config.ROOT).as_posix(),
                title=title, artist=first(common, 'artist', 'TPE1', '\xa9ART'),
                album_artist=first(common, 'albumartist', 'TPE2', 'aART'),
                album=first(common, 'album', 'TALB', '\xa9alb') or path.parent.name,
                genre=first(common, 'genre', 'TCON', '\xa9gen'), year=first(common, 'date', 'year', 'TDRC', '\xa9day'),
                track_no=number(first(common, 'tracknumber', 'TRCK', 'trkn')),
                disc_no=number(first(common, 'discnumber', 'TPOS', 'disk')),
                duration=float(getattr(info, 'length', 0)), format=path.suffix[1:].upper(),
                sample_rate=getattr(info, 'sample_rate', 0), bit_depth=getattr(info, 'bits_per_sample', 0),
                bitrate=getattr(info, 'bitrate', 0), channels=getattr(info, 'channels', 0),
                cover=cover_for(path, audio), tags=json.dumps(raw, ensure_ascii=False), metadata=professional_metadata(tags))


def save_track(db, track):
    existing = db.execute('SELECT id,tags,ai_tags FROM tracks WHERE id=?', (track['id'],)).fetchone()
    replace_search = existing is not None
    if existing and existing['tags'] != track.get('tags', '{}'):
        track['ai_tags'] = '{}'
    # Renames retain favorites, history and playlist references if the old path disappeared.
    if not existing and not track.get('cue_path'):
        st = config.media_path(track['path']).stat()
        old = db.execute('''SELECT t.id,t.path FROM tracks t JOIN files f ON f.path=t.path
          WHERE f.size=? AND f.mtime_ns=? AND t.cue_path IS NULL LIMIT 5''', (st.st_size, st.st_mtime_ns)).fetchall()
        missing = [r for r in old if not config.media_path(r['path']).exists()]
        if len(missing) == 1:
            track['id'] = missing[0]['id']
            replace_search = True
    keys = list(track)
    assignments = ','.join(f'{k}=excluded.{k}' for k in keys if k != 'id')
    db.execute(f'''INSERT INTO tracks({','.join(keys)}) VALUES({','.join('?' for _ in keys)})
      ON CONFLICT(id) DO UPDATE SET {assignments},available=1,updated_at=CURRENT_TIMESTAMP''', list(track.values()))
    if replace_search:
        db.execute('DELETE FROM tracks_fts WHERE id=?', (track['id'],))
    db.execute('INSERT INTO tracks_fts(id,title,artist,album,genre) VALUES(?,?,?,?,?)',
               tuple(track.get(k, '') for k in ('id', 'title', 'artist', 'album', 'genre')))


def read_cue(path):
    data = path.read_bytes()
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        guess = from_bytes(data).best()
        if guess is None:
            raise ValueError('无法识别 CUE 编码')
        text = str(guess)
    album = {'title': path.stem, 'artist': ''}
    tracks, current, source = [], None, None
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r'FILE\s+(?:"([^"]+)"|(\S+))\s+\w+', line, re.I)
        if m:
            source = m.group(1) or m.group(2)
        elif re.match(r'TRACK\s+\d+\s+AUDIO', line, re.I):
            current = {'track_no': number(line), 'source': source}
            tracks.append(current)
        elif (m := re.match(r'(TITLE|PERFORMER)\s+"?(.*?)"?$', line, re.I)):
            (current if current is not None else album)['title' if m.group(1).upper() == 'TITLE' else 'artist'] = m.group(2)
        elif current is not None and (m := re.match(r'INDEX\s+01\s+(\d+):(\d+):(\d+)', line, re.I)):
            current['start'] = int(m[1]) * 60 + int(m[2]) + int(m[3]) / 75
    return album, tracks


def import_cue(db, path):
    album, cues = read_cue(path)
    relative = path.relative_to(config.ROOT).as_posix()
    valid = []
    for index, cue in enumerate(cues):
        if cue.get('source') is None or 'start' not in cue:
            continue
        source = (path.parent / cue['source'].replace('\\', '/')).resolve()
        if not source.is_relative_to(config.ROOT) or not source.is_file():
            raise ValueError('CUE 引用的音源不存在或越界')
        rel_source = source.relative_to(config.ROOT).as_posix()
        row = db.execute('SELECT * FROM tracks WHERE path=? AND cue_path IS NULL', (rel_source,)).fetchone()
        if row is None:
            continue
        track = {k: row[k] for k in ('path', 'folder', 'album_artist', 'genre', 'year', 'disc_no',
                 'format', 'sample_rate', 'bit_depth', 'bitrate', 'channels', 'cover', 'tags', 'metadata')}
        end = row['duration']
        if index + 1 < len(cues) and cues[index + 1].get('source') == cue['source']:
            end = cues[index + 1].get('start', end)
        if not 0 <= cue['start'] < end <= row['duration'] + .2:
            raise ValueError('CUE 时间边界无效')
        track.update(id=identity(relative + '#' + str(cue['track_no'])), cue_path=relative,
                     title=cue.get('title', f"Track {cue['track_no']:02d}"),
                     artist=cue.get('artist', album['artist']) or row['artist'],
                     album=album['title'], track_no=cue['track_no'], start=cue['start'], end=end,
                     duration=end-cue['start'])
        valid.append(track)
    if not valid:
        raise ValueError('CUE 中没有可用曲目')
    db.execute('UPDATE tracks SET available=0 WHERE cue_path=?', (relative,))
    for track in valid:
        save_track(db, track)
        db.execute('UPDATE tracks SET hidden=1 WHERE path=? AND cue_path IS NULL', (track['path'],))


def report_error(path, error):
    state['error_count'] += 1
    state['errors'] = (state['errors'] + [{'path': str(path), 'error': str(error)[:250]}])[-30:]


def scan(scope=''):
    if not scan_lock.acquire(blocking=False):
        return False
    keeper = None
    try:
        root = config.media_path(scope)
        if not root.is_dir():
            root = root.parent
        if not root.is_dir() or not config.ROOT.is_dir():
            raise ValueError('音乐目录不可访问，保留现有索引')
        if not eligible(root):
            return False
        scope = root.relative_to(config.ROOT).as_posix()
        scope = '' if scope == '.' else scope
        state.update(running=True, phase='核对文件与提取标签', visited=0, updated=0,
                     unchanged=0, missing=0, errors=[], error_count=0,
                     started_at=datetime.now(timezone.utc).isoformat(), finished_at=None)
        cover_cache.clear()
        # Keep WAL open between short write transactions; closing the last connection
        # after every track otherwise forces a checkpoint on spinning disks.
        keeper = sqlite3.connect(database.DB_PATH, timeout=30)
        keeper.execute('SELECT count(*) FROM files').fetchone()
        with connect() as db:
            scan_id = db.execute('INSERT INTO scans(scope) VALUES(?)', (scope,)).lastrowid
        seen, cue_paths, source_changed, walk_errors, changed_cover_dirs = set(), [], set(), [], set()
        with connect() as db:
            known = {r['path']: dict(r) for r in db.execute('SELECT * FROM files')}
        for relative in known:
            if Path(relative).suffix.lower() in IMAGE_EXT and (not scope or relative.startswith(scope+'/')):
                if not config.media_path(relative).exists():
                    changed_cover_dirs.add(str(Path(relative).parent).replace('\\', '/'))
        for folder, dirs, filenames in os.walk(root, followlinks=False, onerror=walk_errors.append):
            dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith('.')
                       and not (Path(folder) / d).is_symlink() and not (Path(folder) / d).is_junction()]
            for filename in filenames:
                if Path(filename).suffix.lower() not in IMAGE_EXT:
                    continue
                image = Path(folder) / filename
                relative = image.relative_to(config.ROOT).as_posix()
                try:
                    st = image.stat()
                    seen.add(relative)
                    old = known.get(relative)
                    if not old or old['mtime_ns'] != st.st_mtime_ns or old['size'] != st.st_size:
                        changed_cover_dirs.add(Path(folder).relative_to(config.ROOT).as_posix())
                        with connect() as db:
                            db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?,CURRENT_TIMESTAMP)',
                                       (relative, st.st_mtime_ns, st.st_size, None))
                except OSError as error:
                    report_error(relative, error)
            for filename in filenames:
                path = Path(folder) / filename
                ext = path.suffix.lower()
                if ext not in AUDIO and ext != '.cue':
                    continue
                relative = path.relative_to(config.ROOT).as_posix()
                seen.add(relative)
                try:
                    if path.is_symlink():
                        continue
                    st = path.stat()
                    old = known.get(relative)
                    changed = not old or old['mtime_ns'] != st.st_mtime_ns or old['size'] != st.st_size or bool(old['error'])
                    parents = [path.parent.relative_to(config.ROOT).as_posix()]
                    if path.parent != config.ROOT:
                        parents.append(path.parent.parent.relative_to(config.ROOT).as_posix())
                    changed = changed or any(p in changed_cover_dirs for p in parents)
                    state['visited'] += 1
                    if ext == '.cue':
                        cue_paths.append((path, changed))
                        continue
                    if not changed:
                        state['unchanged'] += 1
                        continue
                    track = extract(path)
                    after = path.stat()
                    if (after.st_mtime_ns, after.st_size) != (st.st_mtime_ns, st.st_size):
                        raise ValueError('文件正在写入，将在下次扫描重试')
                    with connect() as db:
                        save_track(db, track)
                        db.execute('''INSERT OR REPLACE INTO files VALUES(?,?,?,?,CURRENT_TIMESTAMP)''',
                                   (relative, st.st_mtime_ns, st.st_size, None))
                    source_changed.add(relative)
                    state['updated'] += 1
                except Exception as error:
                    report_error(relative, error)
        state['phase'] = '处理 CUE 与失效索引'
        for path, changed in cue_paths:
            try:
                # Source updates may change the duration/tags used by unchanged CUE files.
                if not changed and not any(p.startswith(path.parent.relative_to(config.ROOT).as_posix() + '/') for p in source_changed):
                    state['unchanged'] += 1
                    continue
                st = path.stat()
                with connect() as db:
                    import_cue(db, path)
                    db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?,CURRENT_TIMESTAMP)',
                               (path.relative_to(config.ROOT).as_posix(), st.st_mtime_ns, st.st_size, None))
                state['updated'] += 1
            except Exception as error:
                report_error(path.relative_to(config.ROOT), error)
        if not walk_errors:
            with connect() as db:
                for relative in set(known) - seen:
                    if scope and not relative.startswith(scope + '/'):
                        continue
                    db.execute('UPDATE tracks SET available=0 WHERE path=? OR cue_path=?', (relative, relative))
                    db.execute('DELETE FROM files WHERE path=?', (relative,))
                    state['missing'] += 1
                # Sources become visible again if a CUE was removed.
                db.execute('''UPDATE tracks SET hidden=0 WHERE cue_path IS NULL AND hidden=1
                  AND NOT EXISTS(SELECT 1 FROM tracks v WHERE v.path=tracks.path AND v.cue_path IS NOT NULL AND v.available=1)''')
        for error in walk_errors:
            report_error('目录访问失败，已跳过删除检测', error)
        state.update(phase='扫描完成', finished_at=datetime.now(timezone.utc).isoformat())
        with connect() as db:
            db.execute('UPDATE scans SET finished_at=CURRENT_TIMESTAMP,summary=? WHERE id=?',
                       (json.dumps(state, ensure_ascii=False), scan_id))
        return True
    except Exception as error:
        report_error(scope, error)
        state['phase'] = '扫描失败'
        return False
    finally:
        if keeper:
            keeper.close()
        state['running'] = False
        scan_lock.release()


def request_scan(scope=''):
    config.media_path(scope)
    with pending_lock:
        pending[scope] = time.monotonic()


class Handler(FileSystemEventHandler):
    def on_any_event(self, event):
        if event.event_type not in ('created', 'modified', 'deleted', 'moved'):
            return
        if event.is_directory and event.event_type == 'modified':
            return
        for value in (event.src_path, getattr(event, 'dest_path', None)):
            if not value:
                continue
            path = Path(value)
            if eligible(path):
                folder = path.parent
                try:
                    request_scan(folder.relative_to(config.ROOT).as_posix())
                except ValueError:
                    pass


def start_watcher():
    shutdown.clear()
    observer = Observer()
    if config.ROOT.is_dir():
        observer.schedule(Handler(), str(config.ROOT), recursive=True)
        observer.start()

    def worker():
        last_check = time.monotonic()
        interval = max(5, int(os.getenv('RECONCILE_MINUTES', '60'))) * 60
        while not shutdown.wait(2):
            now = time.monotonic()
            if now - last_check > interval:
                request_scan('')
                last_check = now
            with pending_lock:
                ready = [s for s, t in pending.items() if now-t > 3]
                if '' in ready:
                    ready = ['']
                    pending.clear()
                else:
                    for s in ready:
                        pending.pop(s, None)
            for scope in ready:
                if not scan(scope):
                    if scan_lock.locked():
                        request_scan(scope)
        observer.stop()
        if observer.is_alive():
            observer.join(timeout=5)
    thread = threading.Thread(target=worker, daemon=True, name='library-scanner')
    thread.start()
    if config.flag('SCAN_ON_START', True):
        request_scan('')
    return observer, thread
