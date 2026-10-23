import json
import ast
import sqlite3
from contextlib import contextmanager

from .config import DB_PATH


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=30000')
    db.execute('PRAGMA synchronous=NORMAL')
    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def init():
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
        INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
        CREATE TABLE IF NOT EXISTS files(
          path TEXT PRIMARY KEY, mtime_ns INTEGER, size INTEGER, error TEXT, scanned_at TEXT);
        CREATE INDEX IF NOT EXISTS idx_files_fingerprint ON files(size,mtime_ns);
        CREATE TABLE IF NOT EXISTS tracks(
          id TEXT PRIMARY KEY, path TEXT NOT NULL, folder TEXT NOT NULL,
          title TEXT NOT NULL, artist TEXT DEFAULT '', album_artist TEXT DEFAULT '',
          album TEXT DEFAULT '', genre TEXT DEFAULT '', year TEXT DEFAULT '',
          track_no INTEGER DEFAULT 0, disc_no INTEGER DEFAULT 0,
          duration REAL DEFAULT 0, format TEXT, sample_rate INTEGER DEFAULT 0,
          bit_depth INTEGER DEFAULT 0, bitrate INTEGER DEFAULT 0, channels INTEGER DEFAULT 0,
          cover TEXT, tags TEXT DEFAULT '{}', ai_tags TEXT DEFAULT '{}',
          cue_path TEXT, start REAL DEFAULT 0, end REAL,
          available INTEGER DEFAULT 1, hidden INTEGER DEFAULT 0,
          favorite INTEGER DEFAULT 0, plays INTEGER DEFAULT 0,
          last_played TEXT, added_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album, album_artist);
        CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
        CREATE TABLE IF NOT EXISTS playlists(
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS playlist_tracks(
          playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id), position INTEGER,
          PRIMARY KEY(playlist_id,position));
        CREATE TABLE IF NOT EXISTS playlist_revisions(
          id INTEGER PRIMARY KEY, playlist_id TEXT, snapshot TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS history(
          id INTEGER PRIMARY KEY, track_id TEXT REFERENCES tracks(id), played_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires REAL);
        CREATE TABLE IF NOT EXISTS ai_usage(id INTEGER PRIMARY KEY, kind TEXT,
          input_tokens INTEGER, output_tokens INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY, scope TEXT,
          started_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, summary TEXT);
        CREATE TABLE IF NOT EXISTS enrichment_cache(key TEXT PRIMARY KEY, payload TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
          id UNINDEXED, title, artist, album, genre, tokenize='trigram');
        ''')
        columns = {r[1] for r in db.execute('PRAGMA table_info(tracks)')}
        if 'metadata' not in columns:
            db.execute("ALTER TABLE tracks ADD COLUMN metadata TEXT DEFAULT '{}'")
            from .scanner import professional_metadata
            for row in db.execute('SELECT id,tags FROM tracks').fetchall():
                raw = json.loads(row['tags'] or '{}')
                for key, value in list(raw.items()):
                    if isinstance(value, str) and value.startswith('['):
                        try:
                            raw[key] = ast.literal_eval(value)
                        except (ValueError, SyntaxError):
                            pass
                db.execute('UPDATE tracks SET metadata=? WHERE id=?', (professional_metadata(raw), row['id']))
        db.execute('UPDATE schema_version SET version=2')


def track_dict(row):
    d = dict(row)
    for key in ('tags', 'ai_tags', 'metadata'):
        try:
            d[key] = json.loads(d.get(key) or '{}')
        except (ValueError, TypeError):
            d[key] = {}
    return d
