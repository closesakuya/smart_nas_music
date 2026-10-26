"""Session-authored metadata taxonomy. No API, local model, or audio-file writes.

python -m scripts.enrich_local_tags --apply
Creates an SQLite backup before applying; safe to rerun without duplicate labels.
Unknown sound attributes remain empty rather than being fabricated.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import re
import sqlite3

from backend import config
from backend.db import connect, track_dict

VERSION = 'codex-metadata-2026-10-24-v1'
CATEGORIES = {'Classical': '古典音乐', 'Doujin': '同人音乐', 'J-Pop': '日语流行',
              'Anime': '动画音乐', 'Game-OST': '游戏音乐', 'C-Pop': '华语流行',
              'Sound Horizon': '叙事音乐', 'Instrumental': '器乐音乐', 'Western': '欧美音乐'}
GENRES = [(r'classical|古典', '古典音乐'), (r'j[ -]?pop|japanese pop', '日语流行'),
          (r'c[ -]?pop|mandopop|华语', '华语流行'), (r'cantopop|粤语', '粤语流行'),
          (r'\bpop\b|流行', '流行音乐'), (r'rock|摇滚', '摇滚'), (r'jazz|爵士', '爵士'),
          (r'folk|民谣', '民谣'), (r'blues|蓝调', '蓝调'), (r'r&b|rhythm.*blues', '节奏蓝调'),
          (r'metal|金属', '金属'), (r'electronic|电子', '电子音乐'), (r'trance', 'Trance'),
          (r'hardcore', 'Hardcore'), (r'house', 'House'), (r'ambient', '氛围音乐'),
          (r'new age', '新世纪音乐'), (r'nature sounds', '自然音景'),
          (r'soundtrack|sound track|原声|サウンドトラック', '原声配乐'),
          (r'instrumental|纯音乐|器乐', '器乐音乐'), (r'hip.?hop|rap|说唱', '嘻哈说唱')]
FORMS = [(r'symphon(?:y|ie|ien)|交响曲|交響曲', '交响曲'), (r'concerto|konzert|协奏曲|協奏曲', '协奏曲'),
         (r'sonata|sonate|奏鸣曲|奏鳴曲', '奏鸣曲'), (r'quartet|quartett|四重奏', '室内乐·四重奏'),
         (r'quintet|quintett|五重奏', '室内乐·五重奏'), (r'\btrio\b|三重奏', '室内乐·三重奏'),
         (r'nocturne|夜想曲|夜曲', '夜曲'), (r'\blied(?:er)?\b|艺术歌曲', '艺术歌曲'),
         (r'requiem|安魂曲', '宗教音乐·安魂曲'), (r'\bmass\b|\bmissa\b|弥撒', '宗教音乐·弥撒'),
         (r'\bopera\b|歌剧|歌劇|nibelungen|尼伯龙根|尼伯龍根', '歌剧'),
         (r'\bfugue\b|\bfuge\b|赋格', '赋格'), (r'\betude\b|\bétude\b|练习曲', '练习曲'),
         (r'\bwaltz\b|\bwalzer\b|圆舞曲', '圆舞曲'), (r'\bballet\b|芭蕾', '芭蕾舞剧音乐'),
         (r'eurobeat|euro flash', 'Eurobeat'), (r'vocaloid|初音ミク', 'VOCALOID'),
         (r'piano solo|solo piano|钢琴独奏|ピアノソロ', '钢琴独奏'),
         (r'white noise|白噪音|asmr|nature whisper', '自然音景')]
INSTRUMENTS = [(r'\bpiano\b|\bklavier\b|钢琴|鋼琴|ピアノ', '钢琴'),
               (r'\bviolin\b|\bvioline\b|小提琴', '小提琴'), (r'\bcello\b|violoncello|大提琴', '大提琴'),
               (r'\bflute\b|flöte|长笛|フルート', '长笛'), (r'\bclarinet\b|单簧管', '单簧管'),
               (r'\borgan\b|\borgel\b|管风琴', '管风琴'), (r'harpsichord|羽管键琴', '羽管键琴'),
               (r'\bguitar\b|吉他|ギター', '吉他'), (r'\bharp\b|竖琴', '竖琴'),
               (r'\boboe\b|双簧管', '双簧管'), (r'\btrumpet\b|小号', '小号'),
               (r'\bhorn\b|圆号', '圆号'), (r'\bviola\b|中提琴', '中提琴')]
# Mood is a low-confidence suggestion from explicit descriptors, not a listening result.
MOODS = [(r'\badagio\b|\blento\b|\blargo\b|calm|tranquil|静谧|安らぎ', '舒缓', '放松'),
         (r'\ballegro\b|\bvivace\b|\bpresto\b|欢快|快板', '活泼', '提振精神'),
         (r'\bdolce\b|\bcantabile\b|温柔|優しい', '温柔', '静心聆听'),
         (r'\blament\b|悲歌|挽歌|哀し|悲し', '哀婉', '沉浸聆听'),
         (r'\bfuneral\b|marcia funebre|葬送|送葬', '肃穆', '沉浸聆听'),
         (r'\bmaestoso\b|壮丽|荘厳', '庄严', '沉浸聆听'),
         (r'\bnocturne\b|夜想曲|子守唄|lullaby|摇篮曲|白噪音|white noise|asmr', '宁静', '夜间放松'),
         (r'\bscherzo\b|谐谑曲', '诙谐', '轻松聆听'),
         (r'\bpassion(?:ato)?\b|\bappassionato\b|熱情|热情', '热烈', '沉浸聆听')]

def enrich(track):
    previous = track.get('ai_tags') or {}
    result = dict(previous)
    for key in ('styles', 'moods', 'scenes', 'instruments'):
        result[key] = list(previous.get(key, [])) if isinstance(previous.get(key), list) else []
    evidence = []
    def add(field, label, basis):
        if label not in result[field]: result[field].append(label)
        if basis not in evidence: evidence.append(basis)
    category = track['folder'].split('/')[0]
    if category in CATEGORIES: add('styles', CATEGORIES[category], '目录分类：' + category)
    genre = track.get('genre', '').strip()
    for pattern, label in GENRES:
        if re.search(pattern, genre, re.I): add('styles', label, '原始风格：' + genre)
    title = track['title']
    album = track.get('album', '')
    for pattern, label in FORMS:
        if re.search(pattern, title, re.I): add('styles', label, '曲名包含体裁描述')
    for pattern, label in INSTRUMENTS:
        if re.search(pattern, title, re.I): add('instruments', label, '曲名包含乐器描述')
    for pattern, mood, scene in MOODS:
        if re.search(pattern, title, re.I):
            add('moods', mood, '曲名表情/速度/主题词推断，非音频分析')
            add('scenes', scene, '按曲名描述建议聆听场景')
    if '自然音景' in result['styles'] or re.search('white noise|白噪音|asmr', album, re.I):
        add('styles', '自然音景', '原始标签或专辑自然音景描述')
        add('moods', '舒缓', '自然音景用途推断')
        add('scenes', '休息放松', '自然音景用途建议')
    if re.search(r'\b(?:off vocal|instrumental|karaoke)\b|伴奏|カラオケ', title, re.I):
        if not result.get('vocal'): result['vocal'] = '无主唱/伴奏（曲名标注）'
    result.setdefault('language', '')
    result.setdefault('vocal', '')
    result.update(source=previous.get('source') or 'codex_metadata_taxonomy', basis='metadata_inference',
                  version=2, taxonomy_version=VERSION, confidence=previous.get('confidence', 0.45),
                  reason='；'.join(evidence) + '。未听音频；情感/场景为低置信度建议，无法确定的字段留空。')
    result['unresolved'] = [k for k in ('styles', 'moods', 'instruments', 'language', 'vocal') if not result.get(k)]
    if previous.get('source') and previous.get('source') != 'codex_metadata_taxonomy':
        result['previous_reason'] = previous.get('previous_reason', previous.get('reason', ''))
    return result

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true'); args = parser.parse_args()
    with connect() as conn:
        rows = [track_dict(r) for r in conn.execute('SELECT * FROM tracks WHERE available=1 AND hidden=0 ORDER BY id')]
    coverage = Counter(); changes = []
    for track in rows:
        tags = enrich(track)
        for field in ('styles', 'moods', 'scenes', 'instruments', 'language', 'vocal'):
            if tags.get(field): coverage[field] += 1
        changes.append((json.dumps(tags, ensure_ascii=False), track['id']))
    summary = {'total': len(rows), 'coverage': dict(coverage), 'taxonomy_version': VERSION,
               'api_requests': 0, 'audio_files_modified': 0, 'applied': args.apply}
    if args.apply:
        backups = config.DATA / 'backups'; backups.mkdir(exist_ok=True)
        backup = backups / ('before-local-tags-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.sqlite3')
        with sqlite3.connect(config.DB_PATH) as source, sqlite3.connect(backup) as destination: source.backup(destination)
        # Only the derived tags column changes. Original metadata and audio remain intact.
        with connect() as conn: conn.executemany('UPDATE tracks SET ai_tags=? WHERE id=?', changes)
        summary['backup'] = str(backup)
        summary['completed_at'] = datetime.now(timezone.utc).isoformat()
        (config.DATA / 'local-tag-report.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=True))

if __name__ == '__main__': main()
