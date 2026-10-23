import os
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
load_dotenv(BASE / '.env')


def flag(name: str, default=False):
    return os.getenv(name, str(default)).lower() in ('true', '1', 'yes')


ROOT = Path(os.getenv('MUSIC_ROOT', 'G:/Media/Music')).resolve()
DATA = Path(os.getenv('DATA_DIR', str(BASE / 'data')))
if not DATA.is_absolute():
    DATA = BASE / DATA
DATA = DATA.resolve()
for directory in (DATA, DATA / 'covers', DATA / 'transcode'):
    directory.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA / 'library.sqlite3'
USERNAME = os.getenv('APP_USERNAME', 'admin')
PASSWORD = os.getenv('APP_PASSWORD', '')
FFMPEG = os.getenv('FFMPEG_PATH', 'ffmpeg')
FFPROBE = os.getenv('FFPROBE_PATH', 'ffprobe')


def media_path(relative: str) -> Path:
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError('路径不在音乐目录内')
    return path
