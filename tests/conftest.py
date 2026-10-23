from pathlib import Path


def pytest_sessionstart(session):
    # Keep generated fixtures inside this workspace; system TEMP may have restrictive ACLs.
    (Path(__file__).resolve().parents[1] / '_TMP').mkdir(exist_ok=True)
