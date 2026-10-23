import asyncio

from backend import ai, config, db, scanner
from tests.test_library import wav


def test_ai_proposes_only_existing_tracks_without_writing_playlists(tmp_path, monkeypatch):
    root=tmp_path/'music'
    data=tmp_path/'data'
    root.mkdir()
    for p in (data,data/'covers',data/'transcode'):
        p.mkdir(exist_ok=True)
    monkeypatch.setattr(config,'ROOT',root)
    monkeypatch.setattr(config,'DATA',data)
    monkeypatch.setattr(db,'DB_PATH',data/'test.sqlite3')
    db.init()
    wav(root/'Classical'/'Album'/'01.wav')
    scanner.scan()
    with db.connect() as conn:
        track_id=conn.execute('SELECT id FROM tracks LIMIT 1').fetchone()[0]
    replies=iter([{'terms':[],'folders':['Classical']},
                  {'message':'建议','action':'create','name':'AI 歌单','track_ids':[track_id,'invented-id',track_id]}])
    async def complete(*args,**kwargs):
        return next(replies)
    monkeypatch.setattr(ai,'complete',complete)
    result=asyncio.run(ai.recommend('创建一个歌单',[]))
    assert [t['id'] for t in result['tracks']]==[track_id]
    assert result['action']=='create'
    with db.connect() as conn:
        assert conn.execute('SELECT count(*) FROM playlists').fetchone()[0]==0
