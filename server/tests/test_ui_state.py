"""messenger 0.2.0 — the shared UI-state store: merge/LWW/tombstones/limits/persistence + HTTP."""
from __future__ import annotations

import json
import os
import stat

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import MESSENGER_DIR, load_module

ui = load_module("messenger_ui_state", MESSENGER_DIR / "dashboard" / "ui_state.py")
mapi = load_module("messenger_plugin_api_under_test", MESSENGER_DIR / "dashboard" / "plugin_api.py")


@pytest.fixture()
def client(messenger_state_dir):
    app = FastAPI()
    app.include_router(mapi.router, prefix="/api/plugins/messenger")
    return TestClient(app)


def put(c, keys=None, tombstones=None):
    return c.put("/api/plugins/messenger/state", json={"keys": keys or {}, "tombstones": tombstones or []})


def test_missing_store_is_empty_not_an_error(client):
    r = client.get("/api/plugins/messenger/state")
    assert r.status_code == 200 and r.json() == {"version": 1, "keys": {}}


def test_round_trip_and_shape(client, messenger_state_dir):
    r = put(client, {"session-sort-v1": {"value": {"cody": "name"}, "rev": 3}})
    assert r.status_code == 200
    g = client.get("/api/plugins/messenger/state").json()
    k = g["keys"]["session-sort-v1"]
    assert k["value"] == {"cody": "name"} and k["rev"] == 3 and k["updated_at"].endswith("Z")
    path = messenger_state_dir / "ui-state.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_higher_rev_wins_equal_keeps_server_lower_ignored(client):
    put(client, {"session-colors-v1": {"value": {"s1": "red"}, "rev": 5}})
    put(client, {"session-colors-v1": {"value": {"s1": "blue"}, "rev": 5}})   # equal: keep
    assert client.get("/api/plugins/messenger/state").json()["keys"]["session-colors-v1"]["value"] == {"s1": "red"}
    put(client, {"session-colors-v1": {"value": {"s1": "green"}, "rev": 4}})  # lower: ignore
    assert client.get("/api/plugins/messenger/state").json()["keys"]["session-colors-v1"]["value"] == {"s1": "red"}
    r = put(client, {"session-colors-v1": {"value": {"s1": "teal"}, "rev": 6}})  # higher: win
    assert r.json()["keys"]["session-colors-v1"]["value"] == {"s1": "teal"}
    assert r.json()["keys"]["session-colors-v1"]["rev"] == 6


def test_two_devices_adding_different_entries_both_survive(client):
    put(client, {"hidden-v1": {"value": {"a": True}, "rev": 1}})           # desktop
    r = put(client, {"hidden-v1": {"value": {"b": True}, "rev": 1}})       # phone, same rev
    assert r.json()["keys"]["hidden-v1"]["value"] == {"a": True, "b": True}


def test_tombstone_removes_and_blocks_lower_rev_resurrection(client):
    put(client, {"session-colors-v1": {"value": {"s1": "red", "s2": "blue"}, "rev": 2}})
    r = put(client, tombstones=[{"key": "session-colors-v1", "entry": "s1", "rev": 3}])
    assert r.json()["keys"]["session-colors-v1"]["value"] == {"s2": "blue"}
    assert r.json()["keys"]["session-colors-v1"]["rev"] == 3
    # a stale device still holding s1 at rev 2 or 3 cannot bring it back
    put(client, {"session-colors-v1": {"value": {"s1": "red"}, "rev": 3}})
    assert "s1" not in client.get("/api/plugins/messenger/state").json()["keys"]["session-colors-v1"]["value"]
    # a genuinely later re-add does
    r = put(client, {"session-colors-v1": {"value": {"s1": "gold"}, "rev": 4}})
    assert r.json()["keys"]["session-colors-v1"]["value"]["s1"] == "gold"
    # a stale tombstone (lower than the entry) does not delete it
    r = put(client, tombstones=[{"key": "session-colors-v1", "entry": "s1", "rev": 4}])
    assert r.json()["keys"]["session-colors-v1"]["value"]["s1"] == "gold"


def test_device_local_and_unknown_keys_are_refused_by_name(client):
    for key in ("expanded-v1", "search", "activity-toasts", "pane-width", "messenger-expanded-v1"):
        r = put(client, {key: {"value": {}, "rev": 1}})
        assert r.status_code == 400 and key in r.json()["detail"] and "device-local" in r.json()["detail"]
    r = put(client, {"nonsense-v9": {"value": {}, "rev": 1}})
    assert r.status_code == 400 and "unknown" in r.json()["detail"]
    r = put(client, {"messenger-session-sort-v1": {"value": {}, "rev": 1}})
    assert r.status_code == 400 and "unprefixed" in r.json()["detail"]
    r = put(client, tombstones=[{"key": "expanded-v1", "entry": "x", "rev": 1}])
    assert r.status_code == 400
    assert client.get("/api/plugins/messenger/state").json()["keys"] == {}


@pytest.mark.parametrize("body", [
    [], {"keys": []}, {"keys": {"hidden-v1": {"rev": 1}}}, {"keys": {"hidden-v1": {"value": [], "rev": 1}}},
    {"keys": {"hidden-v1": {"value": {}, "rev": -1}}}, {"keys": {"hidden-v1": {"value": {}, "rev": True}}},
    {"keys": {"hidden-v1": {"value": {}, "rev": "3"}}}, {"keys": {"hidden-v1": {"value": {}, "rev": 1, "x": 1}}},
    {"tombstones": [{"key": "hidden-v1", "entry": "", "rev": 1}]}, {"junk": 1},
])
def test_unknown_shapes_are_400_and_store_nothing(client, body):
    r = client.put("/api/plugins/messenger/state", json=body)
    assert r.status_code == 400, body
    assert client.get("/api/plugins/messenger/state").json()["keys"] == {}


def test_limits_413_over_256kb_and_400_over_64_keys(client):
    big = {"session-colors-v1": {"value": {f"s{i}": "x" * 300 for i in range(1000)}, "rev": 1}}
    r = client.put("/api/plugins/messenger/state", content=json.dumps({"keys": big}),
                   headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    many = {f"k{i}": {"value": {}, "rev": 1} for i in range(65)}
    r = put(client, many)
    assert r.status_code == 400 and "too many keys" in r.json()["detail"]
    assert client.put("/api/plugins/messenger/state", content=b"{nope",
                      headers={"Content-Type": "application/json"}).status_code == 400


def test_corrupt_store_is_backed_up_and_starts_empty(client, messenger_state_dir):
    put(client, {"hidden-v1": {"value": {"a": True}, "rev": 1}})
    path = messenger_state_dir / "ui-state.json"
    path.write_text("{garbage")
    assert client.get("/api/plugins/messenger/state").json()["keys"] == {}
    assert any(p.name.startswith("ui-state.json.bad-") for p in messenger_state_dir.iterdir())
    r = put(client, {"hidden-v1": {"value": {"b": True}, "rev": 1}})
    assert r.status_code == 200 and r.json()["keys"]["hidden-v1"]["value"] == {"b": True}


def test_existing_routes_untouched(client):
    assert client.get("/api/plugins/messenger/health").json()["ok"] is True
    assert client.get("/api/plugins/messenger/search").json()["results"] == []


def test_merge_is_pure_and_counts():
    state = {"version": 1, "keys": {}}
    c1 = ui.merge(state, {"sections-v1": {"value": {"sections": [1], "sort": "name"}, "rev": 2}}, [])
    c2 = ui.merge(state, {"sections-v1": {"value": {"sections": [2]}, "rev": 2}}, [])
    assert c1 == {"applied": 2, "ignored": 0} and c2 == {"applied": 0, "ignored": 1}
    assert ui.view(state)["keys"]["sections-v1"]["value"] == {"sections": [1], "sort": "name"}
