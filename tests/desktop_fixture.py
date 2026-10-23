"""Isolated silent-audio server for native client verification; never scans the real library."""
import os
from pathlib import Path
import wave

base = Path(__file__).resolve().parents[1] / '_TMP' / 'desktop-fixture'
root = base / 'music'
root.mkdir(parents=True, exist_ok=True)
for bits in (16, 24):
    with wave.open(str(root / f'Silent {bits}bit.wav'), 'wb') as file:
        file.setparams((2, bits // 8, 44100, 0, 'NONE', 'not compressed'))
        file.writeframes(b'\0' * (44100 * 12 * 2 * bits // 8))
os.environ.update(MUSIC_ROOT=str(root), DATA_DIR=str(base / 'data'),
                  APP_USERNAME='desktop-test', APP_PASSWORD='desktop-test-password',
                  SCAN_ON_START='false', COOKIE_SECURE='false')
from backend import db, scanner
db.init()
scanner.scan()
if __name__ == '__main__':
    import uvicorn
    uvicorn.run('backend.main:app', host='127.0.0.1', port=18765)
