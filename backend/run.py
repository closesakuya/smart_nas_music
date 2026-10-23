import argparse
import os

import uvicorn

from . import config

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    uvicorn.run('backend.main:app', host=os.getenv('HOST', '0.0.0.0'),
                port=args.port or int(os.getenv('PORT', '8765')), proxy_headers=False)
