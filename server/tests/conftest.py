"""Shared fixtures for the server-plugin suites (personae-mobile-auth + messenger).

Everything runs against the REPO copies under ``server/`` (the source of record) with state and
audit output redirected to a temp dir — the live plugin state and the real audit log are never
touched.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent
AUTH_DIR = SERVER / "personae-mobile-auth"
MESSENGER_DIR = SERVER / "messenger"

_TMP = tempfile.mkdtemp(prefix="personae-server-tests-")
os.environ["HERMES_HOME"] = _TMP  # audit log -> temp, never the live dashboard-auth.log
os.environ["PERSONAE_MOBILE_AUTH_STATE_DIR"] = os.path.join(_TMP, "auth-state")
os.environ["MESSENGER_STATE_DIR"] = os.path.join(_TMP, "messenger-state")
os.environ["PERSONAE_STATE_DIR"] = os.path.join(_TMP, "personae-state")

# A strong, obviously-fake bearer for the tests (never a real credential).
TEST_BEARER = "T3st-Only_" + "".join(chr(65 + (i * 7) % 26) + chr(97 + (i * 11) % 26) + str(i % 10)
                                     for i in range(20))


def load_module(name: str, path: Path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def auth_state_dir():
    d = Path(os.environ["PERSONAE_MOBILE_AUTH_STATE_DIR"])
    if d.exists():
        for f in d.iterdir():
            f.unlink()
    store = load_module("personae_mobile_auth_store", AUTH_DIR / "store.py")
    store.reset_for_tests()
    yield d
    store.reset_for_tests()


@pytest.fixture()
def state_dir():
    """personae-mobile-state's own store: emptied for each test, never the live one."""
    d = Path(os.environ["PERSONAE_STATE_DIR"])
    if d.exists():
        for f in d.iterdir():
            if f.is_file():
                f.unlink()
    d.mkdir(parents=True, exist_ok=True)
    yield d


@pytest.fixture()
def messenger_state_dir():
    d = Path(os.environ["MESSENGER_STATE_DIR"])
    if d.exists():
        for f in d.iterdir():
            f.unlink()
    yield d
