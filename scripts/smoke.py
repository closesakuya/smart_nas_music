"""Live service checks. Never prints credentials or remote authorization headers."""
import argparse
import asyncio
import hashlib
import json
import os

import httpx
from dotenv import load_dotenv

from pathlib import Path
load_dotenv(Path(__file__).resolve().parents[1] / '.env')


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ai', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--tags', action='store_true')
    parser.add_argument('--dav', action='store_true')
    args = parser.parse_args()
    base = 'http://127.0.0.1:' + os.getenv('PORT', '8765')
    async with httpx.AsyncClient(base_url=base, timeout=600) as client:
        assert (await client.get('/api/health')).status_code == 200
        assert (await client.get('/api/tracks')).status_code == 401
        login = await client.post('/api/login', json={'username':os.getenv('APP_USERNAME'), 'password':os.getenv('APP_PASSWORD')})
        assert login.status_code == 200, login.status_code
        stats = (await client.get('/api/stats')).json()
        scan = {k:v for k,v in stats['scan'].items() if k!='errors'}
        print(json.dumps({'tracks':stats['tracks'], 'albums':stats['albums'], 'scan':scan}, ensure_ascii=True))
        if args.status:
            return
        tracks = (await client.get('/api/tracks', params={'limit':300})).json()['items']
        for fmt in ('FLAC','MP3','WAV'):
            match = next((t for t in tracks if t['format'] == fmt), None)
            if not match:
                from backend.db import connect, track_dict
                with connect() as db:
                    row = db.execute('SELECT * FROM tracks WHERE format=? AND available=1 AND hidden=0 AND cue_path IS NULL LIMIT 1',(fmt,)).fetchone()
                    match = track_dict(row) if row else None
            if not match:
                continue
            url = f"/api/tracks/{match['id']}/stream"
            response = await client.get(url, headers={'Range':'bytes=1024-5119'})
            path = Path(os.getenv('MUSIC_ROOT')) / match['path']
            with path.open('rb') as f:
                f.seek(1024)
                expected = f.read(4096)
            assert response.status_code == 206 and response.content == expected
            print(fmt + ' original Range matches source bytes')
        if tracks:
            t = tracks[0]
            converted = await client.get(f"/api/tracks/{t['id']}/stream", params={'quality':'128'}, headers={'Range':'bytes=0-1023'})
            assert converted.status_code == 206, converted.text[:200]
            print('MP3 128k transcode + Range OK')
        if args.ai:
            response = await client.post('/api/ai/chat', json={'message':'推荐3首适合安静听的歌曲，暂时不要保存歌单。'})
            print('AI HTTP', response.status_code)
            if response.status_code == 200:
                result = response.json()
                assert result['tracks']
                print(json.dumps({'message':result['message'], 'tracks':len(result['tracks']), 'action':result['action']},ensure_ascii=True))
            else:
                print(json.dumps(response.json(), ensure_ascii=True))
                raise SystemExit(1)
        if args.tags and tracks:
            response = await client.post('/api/ai/tags', json={'track_ids':[tracks[0]['id']]})
            assert response.status_code == 200
            for _ in range(60):
                await asyncio.sleep(1)
                state = (await client.get('/api/stats')).json()['tags']
                if not state['running']:
                    assert not state['errors'], state
                    updated = (await client.get('/api/tracks/'+tracks[0]['id'])).json()
                    assert updated['ai_tags'].get('source') == 'deepseek'
                    print('AI metadata labels persisted with provenance')
                    break
            else:
                raise AssertionError('AI tagging timed out')
        if args.dav:
            response=await client.post('/api/webdav/check')
            print('WebDAV check HTTP',response.status_code)
            print(json.dumps(response.json(),ensure_ascii=True))
            if response.status_code == 200 and tracks:
                from starlette.requests import Request
                from backend.storage import dav_stream
                sample = next(t for t in tracks if not t['cue_path'])
                request = Request({'type':'http','method':'GET','scheme':'http','path':'/',
                    'query_string':b'','server':('localhost',8765),'client':('127.0.0.1',1234),
                    'headers':[(b'range',b'bytes=1024-5119')]})
                streamed = await dav_stream(sample, request, 'audio/flac')
                received = b''.join([chunk async for chunk in streamed.body_iterator])
                with (Path(os.getenv('MUSIC_ROOT'))/sample['path']).open('rb') as f:
                    f.seek(1024)
                    expected = f.read(4096)
                assert streamed.status_code == 206 and received == expected
                print('Live WebDAV Range matches local source bytes')
        print('Live smoke checks passed')


if __name__ == '__main__':
    asyncio.run(main())
