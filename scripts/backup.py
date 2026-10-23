"""Create a consistent SQLite backup, including committed WAL transactions."""
import sqlite3
from datetime import datetime

from backend import config

if __name__ == '__main__':
    directory = config.DATA / 'backups'
    directory.mkdir(exist_ok=True)
    target = directory / ('library-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.sqlite3')
    with sqlite3.connect(config.DB_PATH) as source, sqlite3.connect(target) as destination:
        source.backup(destination)
    print(target)
