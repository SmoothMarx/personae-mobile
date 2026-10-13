"""personae-mobile-state 1.0.0 (Personae Mobile 0.9.0 Phase A) — the state surface.

Two things are proved here:

1. **the verbs are the dashboard's own.** ``POST /sessions/{id}/archive`` and
   ``POST /sessions/{id}/delete`` must call core's ``rename_session_endpoint`` /
   ``delete_session_endpoint`` — asserted by counting the calls on a spy, not by trusting a comment.
   The one added rule is that a pinned session is refused (409, ``error: "pinned"``).

2. **the preference document.** Per-key last-write-wins; a stale ``revision`` never clobbers; a
   device-local key is refused BY NAME WITH THE REASON; the split is published at
   ``GET /preferences/keys``.
"""
from __future__ import annotations

import json
import os
import stat

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import SERVER, load_module

papi = load_module("personae_state_plugin_api", SERVER / "personae-mobile-state" / "dashboard" / "plugin_api.py")
prefs = load_module("personae_state_preferences", SERVER / "personae-mobile-state" / "dashboard" / "preferences.py")

PREFIX = "/api/plugins/personae-mobile-state"


@pytest.fixture()
def client(state_dir):
    app = FastAPI()
    app.include_router(papi.router, prefix=PREFIX)
    return TestClient(app)


def post_prefs(c, body, profile=""):
    return c.post(f"{PREFIX}/preferences", params={"profile": profile or ""}, json=body)


# ────────────────────────────────────────────── the preference document ──


def test_9_0_A_document_starts_empty_and_revision_zero(client):
    r = client.get(f"{PREFIX}/preferences")
    assert r.status_code == 200
    body = r.json()
    assert body["revision"] == 0 and body["preferences"] == {} and body["revs"] == {}


def test_9_0_A_only_portable_preferences_sync(client):
    r = post_prefs(client, {"preferences": {"session-types": {"sessions": True, "automatic": False}}})
    assert r.status_code == 200
    assert r.json()["preferences"]["session-types"] == {"sessions": True, "automatic": False}


def test_9_0_A_device_local_keys_are_refused_with_the_reason(client):
    """'Gateway Settings' must never sync — and the 400 has to say WHY, not just 'unknown'."""
    for key in ("api-key", "base-url", "routes", "pairing", "device-id", "push-token",
                "notification-permission", "language"):
        r = post_prefs(client, {"preferences": {key: "whatever"}})
        assert r.status_code == 400, key
        body = r.json()
        detail = body["error"]["message"]
        assert "device-local" in detail and "never synced" in detail, (key, detail)
        assert body["error"]["code"] == "bad_request"
    # …and an unknown key is a different refusal, so the two are distinguishable.
    r = post_prefs(client, {"preferences": {"nonsense": 1}})
    assert r.status_code == 400 and "unknown preference" in r.json()["error"]["message"]


def test_9_0_A_per_key_last_write_wins_two_devices_editing_different_keys_both_survive(client):
    """The phone edits notifications, the desktop edits session types, neither has seen the other."""
    first = post_prefs(client, {"preferences": {"notifications": {"enabled": True}}})
    seen = first.json()["revision"]
    second = post_prefs(client, {"revision": seen, "preferences": {"session-types": {"sessions": False}}})
    merged = second.json()["preferences"]
    assert merged["notifications"] == {"enabled": True}
    assert merged["session-types"] == {"sessions": False}


def test_9_0_A_a_stale_revision_never_clobbers(client):
    post_prefs(client, {"preferences": {"notifications": {"enabled": True, "waiting": True}}})
    stale = client.get(f"{PREFIX}/preferences").json()
    # A later write by someone else, at a higher per-key rev.
    post_prefs(client, {"revision": stale["revision"], "preferences": {"notifications": {"enabled": False}}})
    # The first device now writes again, still believing the revision it read at the very beginning.
    r = post_prefs(client, {"revision": 0, "preferences": {"notifications": {"enabled": True, "waiting": False}}})
    assert r.status_code == 200
    assert r.json()["preferences"]["notifications"] == {"enabled": False}, "a lower rev must not win"


def test_9_0_A_revision_is_monotonic(client):
    """A client that reads the reply before writing again keeps making progress; a blind writer does not."""
    rev = 0
    seen = []
    for i in range(6):
        rev = post_prefs(client, {"revision": rev, "preferences": {"display-order": {"n": i}}}).json()["revision"]
        seen.append(rev)
    assert seen == sorted(seen) and seen[-1] > seen[0], seen
    # a writer that never read the document cannot overwrite what it never saw…
    blind = post_prefs(client, {"preferences": {"display-order": {"n": 99}}}).json()
    assert blind["preferences"]["display-order"] == {"n": 5}
    assert blind["kept"] == 1
    # …and a read-only patch cannot walk the revision backwards either
    r = post_prefs(client, {"revision": 0, "preferences": {}})
    assert r.json()["revision"] >= seen[-1]


def test_9_0_A_the_split_is_published_not_guessed(client):
    body = client.get(f"{PREFIX}/preferences/keys").json()
    assert set(body["portable"]) == {"session-types", "notifications", "display-order"}
    assert "api-key" in body["device_local"] and "base-url" in body["device_local"]
    assert all(isinstance(why, str) and len(why.split()) >= 5 for why in body["device_local"].values())


def test_9_0_A_stored_document_is_0600_and_per_profile(client, state_dir):
    post_prefs(client, {"preferences": {"notifications": {"enabled": True}}}, profile="default")
    post_prefs(client, {"preferences": {"notifications": {"enabled": False}}}, profile="beta")
    a = state_dir / "preferences-default.json"
    b = state_dir / "preferences-beta.json"
    assert a.exists() and b.exists(), "one document per profile"
    assert stat.S_IMODE(os.stat(a).st_mode) == 0o600
    assert json.loads(a.read_text())["preferences"]["notifications"] == {"enabled": True}
    assert json.loads(b.read_text())["preferences"]["notifications"] == {"enabled": False}


def test_9_0_A_corrupt_document_is_quarantined_not_fatal(client, state_dir):
    path = state_dir / "preferences-default.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json")
    r = client.get(f"{PREFIX}/preferences")
    assert r.status_code == 200 and r.json()["revision"] == 0
    assert list(state_dir.glob("preferences-default.json.bad-*")), "the bad file is kept, not deleted"


def test_9_0_A_a_document_carrying_a_device_local_key_is_rejected_at_load(state_dir):
    path = state_dir / "preferences-default.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "revision": 3, "preferences": {"api-key": "hit"}, "revs": {}}))
    doc = prefs.load("default")
    assert doc["preferences"] == {}, "a hand-written document cannot smuggle a device-local key in"


def test_9_0_A_body_and_value_caps(client):
    assert post_prefs(client, {"preferences": {"notifications": "x" * (prefs.MAX_VALUE_BYTES + 1)}}).status_code == 413
    assert client.post(f"{PREFIX}/preferences", content=b"not json").status_code == 400


# ───────────────────────────────────────────────────────── the verbs ──


def test_9_0_A_archive_calls_the_dashboard_own_flags_verb(client, monkeypatch):
    import hermes_cli.web_routers.sessions as core
    from hermes_cli.web_models import SessionRename

    calls = []

    async def spy(session_id, body):
        calls.append((session_id, body))
        return {"ok": True, "title": "t", "archived": True}

    def no_pin(profile, fn, *, read_only):
        return None  # "session not found" — not pinned

    monkeypatch.setattr(core, "rename_session_endpoint", spy)
    monkeypatch.setattr(core, "_with_db", no_pin)
    r = client.post(f"{PREFIX}/sessions/sess-1/archive")
    assert r.status_code == 200 and r.json()["action"] == "archive"
    assert len(calls) == 1 and calls[0][0] == "sess-1"
    assert isinstance(calls[0][1], SessionRename) and calls[0][1].archived is True


def test_9_0_A_a_pinned_session_is_not_archivable(client, monkeypatch):
    import hermes_cli.web_routers.sessions as core

    calls = []

    async def spy(session_id, body):  # pragma: no cover - must never be reached
        calls.append(session_id)
        return {}

    def pinned(profile, fn, *, read_only):
        return True

    monkeypatch.setattr(core, "rename_session_endpoint", spy)
    monkeypatch.setattr(core, "_with_db", pinned)
    r = client.post(f"{PREFIX}/sessions/sess-pin/archive")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "pinned" and "Unpin" in r.json()["error"]["message"]
    assert calls == [], "the verb must not be reached at all for a pinned session"


def test_9_0_A_delete_calls_the_dashboard_own_delete_verb(client, monkeypatch):
    import hermes_cli.web_routers.sessions as core

    calls = []

    async def spy(session_id, profile=None):
        calls.append((session_id, profile))
        return {"ok": True}

    monkeypatch.setattr(core, "delete_session_endpoint", spy)
    r = client.post(f"{PREFIX}/sessions/sess-9/delete", params={"profile": "beta"})
    assert r.status_code == 200 and r.json()["action"] == "delete"
    assert calls == [("sess-9", "beta")], "the profile scoping travels through untouched"


def test_9_0_A_the_surface_answers_after_the_change(client):
    """§4 of the goal: a test that the surface still answers AFTER the change, not a note."""
    r = client.get(f"{PREFIX}/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "plugin": "personae-mobile-state",
                        "verbs": ["archive", "delete"], "preferences": True}
    # every route this backend publishes answers something, with or without a store
    assert client.get(f"{PREFIX}/preferences").status_code == 200
    assert client.get(f"{PREFIX}/preferences/keys").status_code == 200


# ── 0.9.1 S4.2: the session-types value widened from two booleans to four, with NO server change ──


def test_9_1_S42_a_four_boolean_session_types_round_trips_untouched(client):
    """`session-types` carries four booleans now, and the document stores them as they are.

    This is the assertion behind "no server change is needed": the document validates KEY NAMES and a
    byte cap, never the value's shape, so the widened setting travels through it untouched. Asserted as
    a round trip rather than trusted as a sentence — and the LEGACY two-boolean shape is asserted right
    beside it, because a desktop that has not been updated yet may still be writing that one.
    """
    four = {"sessions": True, "cron": True, "webhook": False, "oneshot": True}
    first = post_prefs(client, {"preferences": {"session-types": four}})
    assert first.status_code == 200, first.text
    assert first.json()["preferences"]["session-types"] == four, "keys and values both survive"

    # …and read it back through a second request, not just the POST's own echo.
    again = client.get(f"{PREFIX}/preferences").json()
    assert again["preferences"]["session-types"] == four

    legacy = {"sessions": True, "automatic": False}
    second = post_prefs(
        client,
        {"revision": first.json()["revision"], "preferences": {"session-types": legacy}},
    )
    assert second.status_code == 200, second.text
    assert second.json()["preferences"]["session-types"] == legacy, (
        "the old shape is stored verbatim, not rewritten — the APP is the only thing that migrates it"
    )


def test_9_1_S42_the_document_validates_key_names_and_bytes_not_the_value_shape(client):
    """The other half of "no server change": a value the app would never write is still accepted.

    The document knows which KEYS may sync and how big a value may be (8 KB). It deliberately does not
    know what a session-type is, so widening that setting is a client-side change by construction.
    """
    assert post_prefs(client, {"preferences": {"session-types": "anything"}}).status_code == 200
    assert post_prefs(client, {"preferences": {"session-types": [1, 2, 3]}}).status_code == 200
    # the two things it DOES police are still policed
    assert post_prefs(client, {"preferences": {"api-key": "never"}}).status_code == 400
    assert post_prefs(client, {"preferences": {"session-types": "x" * 9000}}).status_code == 413
