"""Read-only local lyrics: bounded sidecars and embedded lyrics, no network calls."""
import mutagen
from charset_normalizer import from_bytes
from . import config

def read_lyrics(track):
    audio_path = config.media_path(track['path'])
    candidates = [audio_path.with_suffix('.lrc')]
    title = track['title']
    if title and not any(c in title for c in '/\\:*?"<>|') and not title.endswith((' ', '.')):
        candidates.insert(0, audio_path.parent / (title + '.lrc'))
    for path in candidates:
        try:
            resolved = path.resolve()
            if not resolved.is_relative_to(config.ROOT) or not resolved.is_file() or resolved.stat().st_size > 1_000_000:
                continue
            raw = resolved.read_bytes()
        except OSError:
            continue
        if raw:
            try:
                text = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                decoded = from_bytes(raw).best()
                text = str(decoded) if decoded else ''
            if text.strip():
                return {'text': text, 'source': '同目录 LRC', 'offset': float(track.get('start', 0) or 0) if path == audio_path.with_suffix('.lrc') else 0}
    text = (track.get('metadata') or {}).get('lyrics', '')
    if not text and audio_path.is_file():
        try:
            audio = mutagen.File(audio_path)
            tags = audio.tags if audio else None
            if tags:
                synced = getattr(tags, 'getall', lambda _: [])('SYLT')
                frames = getattr(tags, 'getall', lambda _: [])('USLT')
                if synced and synced[0].format == 2:
                    text = '\n'.join(f'[{ms // 60000:02d}:{ms % 60000 / 1000:06.3f}]{words}' for words, ms in synced[0].text)
                elif frames:
                    text = frames[0].text
                else:
                    for key in ('lyrics', 'LYRICS', 'unsyncedlyrics', '\xa9lyr'):
                        value = tags.get(key)
                        if value:
                            text = value[0] if isinstance(value, list) else str(value)
                            break
        except (OSError, mutagen.MutagenError):
            pass
    return {'text': str(text)[:1_000_000], 'source': '内嵌歌词' if text else '暂无本地歌词', 'offset': float(track.get('start', 0) or 0)}
