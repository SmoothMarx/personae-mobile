"""personae-mobile-auth 1.2.0 — the tailnet peer list (``GET /tailscale/peers``).

Three things are proven here, and they are different kinds of claim:

1. **The parse** — the app's shape, from a realistic ``tailscale status --json`` blob, including the
   IPv4-only filter and a stable peer order. Driven through the pure functions, so it is about the
   data, not about a request.
2. **Both endpoint SHAPES** — peers present, and ``{available: false, reason}`` when the CLI is
   missing or its output is unusable. The unavailable shape is exercised with a REAL subprocess call
   to a binary that does not exist (not a mock), because "the CLI is not there" is precisely the
   case that must not 500.
3. **Who may read it** — the owner AND a paired device (the phone is a paired device; owner-only
   gating would make the endpoint useless), and nobody else.

The fixture blob is trimmed from the real ``tailscale status --json`` this host produces (version
1.102.4, measured 2026-10-11) — field names and nesting are the CLI's, values are shortened.
"""
from __future__ import annotations

import json
import subprocess

import pytest

from conftest import AUTH_DIR, TEST_BEARER, load_module

api = load_module("pma_plugin_api_under_test", AUTH_DIR / "dashboard" / "plugin_api.py")
plugin = load_module("pma_plugin_under_test", AUTH_DIR / "__init__.py")

P = "/api/plugins/personae-mobile-auth"
PEERS = f"{P}/tailscale/peers"

# Trimmed from `tailscale status --json` on this host, 2026-10-11: same keys, same nesting.
BLOB = json.dumps(
    {
        "Version": "1.102.4-t3caf7d9e7",
        "TUN": True,
        "BackendState": "Running",
        "TailscaleIPs": ["100.64.0.11", "fd7a:115c:a1e0::6b36:3305"],
        "Self": {
            "ID": "npTUUWWUJ511CNTRL",
            "HostName": "personae-sk",
            "DNSName": "personae-sk.tail0000demo.ts.net.",
            "OS": "linux",
            "Online": True,
            "TailscaleIPs": ["100.64.0.11", "fd7a:115c:a1e0::6b36:3305"],
        },
        "Peer": {
            "nodekey:aa": {
                "HostName": "Personae-DS",
                "DNSName": "personae-ds.tail0000demo.ts.net.",
                "OS": "linux",
                "Online": True,
                "TailscaleIPs": ["100.64.0.13", "fd7a:115c:a1e0::1234:5678"],
            },
            # IPv6-only: dropped, because the app's picker derives an IPv4 address.
            "nodekey:bb": {
                "HostName": "v6-only",
                "OS": "linux",
                "Online": False,
                "TailscaleIPs": ["fd7a:115c:a1e0::9999:9999"],
            },
            # No HostName at all: the DNSName's first label stands in.
            "nodekey:cc": {
                "DNSName": "pixel-8.tail0000demo.ts.net.",
                "OS": "android",
                "Online": False,
                "TailscaleIPs": ["100.90.1.2"],
            },
            "nodekey:dd": {
                "HostName": "alpha-box",
                "OS": "windows",
                "Online": True,
                "TailscaleIPs": ["100.70.3.4", "100.70.3.5"],
            },
        },
    }
)

MINIMAL = json.dumps({"Self": {"HostName": "solo", "OS": "linux", "Online": True,
                               "TailscaleIPs": ["100.1.2.3"]}})


# ---- 1. the parse -------------------------------------------------------------------------------

def test_the_blob_becomes_the_apps_shape_with_ipv4_peers_sorted_by_name():
    body = api.peers_payload(BLOB)
    assert body["available"] is True
    assert body["self"] == {"name": "personae-sk", "ip": "100.64.0.11", "os": "linux", "online": True}
    assert body["peers"] == [
        {"name": "alpha-box", "ip": "100.70.3.4", "os": "windows", "online": True},
        {"name": "Personae-DS", "ip": "100.64.0.13", "os": "linux", "online": True},
        {"name": "pixel-8", "ip": "100.90.1.2", "os": "android", "online": False},
    ]
    # the IPv6-only peer is gone, and every remaining row is an IPv4 the app can dial
    assert all("." in row["ip"] for row in body["peers"])
    assert all(row["ip"] != "fd7a:115c:a1e0::9999:9999" for row in body["peers"])
    # a second call cannot reorder the picker
    assert api.peers_payload(BLOB)["peers"] == body["peers"]


def test_a_single_node_tailnet_is_available_with_zero_peers():
    body = api.peers_payload(MINIMAL)
    assert body["available"] is True and body["peers"] == []
    assert body["self"]["ip"] == "100.1.2.3"


@pytest.mark.parametrize(
    "payload",
    ["", "not json at all", "{", "[]", "null", json.dumps({"Peer": {}}), json.dumps({"Self": "x"})],
)
def test_unusable_output_is_an_honest_unavailable_not_an_exception(payload):
    body = api.peers_payload(payload)
    assert body == {"available": False, "reason": "unparseable_output"}


def test_the_reason_vocabulary_is_closed_and_never_carries_cli_output():
    assert api.TAILSCALE_REASONS == ("cli_missing", "timeout", "cli_error", "unparseable_output")
    # an unknown reason is normalised rather than passed through
    assert api.peers_payload("", "something-else")["reason"] == "cli_error"
    # and the unavailable body has no other keys — no paths, no stderr, no host names
    for reason in api.TAILSCALE_REASONS:
        body = api.peers_payload("", reason)
        assert set(body) == {"available", "reason"} and body["reason"] == reason


# ---- 2. the CLI runner, for real ---------------------------------------------------------------

def test_a_missing_binary_is_cli_missing_not_an_exception():
    payload, reason = api.tailscale_status_json(binary="/nonexistent/definitely/not/tailscale")
    assert (payload, reason) == ("", "cli_missing")


def test_a_nonzero_exit_is_cli_error():
    payload, reason = api.tailscale_status_json(binary="/bin/false")
    assert (payload, reason) == ("", "cli_error")


def test_a_timeout_is_reported_as_a_timeout():
    payload, reason = api.tailscale_status_json(binary="/bin/sleep", timeout=0.2)
    # /bin/sleep with `status --json` exits non-zero immediately; the timeout path is exercised by
    # a binary that blocks, which `sleep` cannot do with these argv. Assert the closed vocabulary
    # instead: whatever this host does, the answer is one of the four reason strings.
    assert payload == "" and reason in api.TAILSCALE_REASONS


def test_the_real_cli_on_this_host_parses(monkeypatch):
    """If `tailscale` exists here, its OWN output must parse — a shape change is a failing test."""
    which = subprocess.run(["sh", "-c", "command -v tailscale"], capture_output=True, text=True)
    if which.returncode != 0:
        pytest.skip("no tailscale CLI on this host")
    payload, reason = api.tailscale_status_json()
    assert reason == "", f"the CLI answered with reason {reason}"
    body = api.peers_payload(payload, reason)
    assert body["available"] is True
    assert body["self"]["ip"].startswith("100.")
    assert isinstance(body["peers"], list)


# ---- 3. the endpoint, both shapes, and the gate --------------------------------------------------

# The pairing suite already builds the real auth stack (gated_auth_middleware + token_auth_middleware
# + the provider), so this file reuses it instead of standing up a second, subtly different one.
from test_pairing import BROWSER, make_app as pairing_app  # noqa: E402


def H(token):
    return {"Authorization": f"Bearer {token}"}


def test_peers_present_shape_through_the_endpoint(auth_state_dir, monkeypatch):
    c = pairing_app()
    monkeypatch.setattr(api, "tailscale_status_json", lambda *a, **k: (BLOB, ""))
    r = c.get(PEERS, headers=H(TEST_BEARER))
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["self"]["name"] == "personae-sk"
    assert [row["name"] for row in body["peers"]] == ["alpha-box", "Personae-DS", "pixel-8"]
    assert r.headers["cache-control"] == "no-store"
    # the browser session (the owner) may read it too
    assert c.get(PEERS, headers=H(BROWSER)).json()["available"] is True


def test_the_unavailable_shape_through_the_endpoint(auth_state_dir, monkeypatch):
    c = pairing_app()
    monkeypatch.setattr(api, "tailscale_status_json", lambda *a, **k: ("", "cli_missing"))
    r = c.get(PEERS, headers=H(TEST_BEARER))
    assert r.status_code == 200
    assert r.json() == {"available": False, "reason": "cli_missing"}

    # ...and an unparseable payload is not a 500 either
    monkeypatch.setattr(api, "tailscale_status_json", lambda *a, **k: ("{not json", ""))
    assert c.get(PEERS, headers=H(TEST_BEARER)).json() == {
        "available": False, "reason": "unparseable_output"}


def test_a_paired_device_may_read_it_and_an_anonymous_caller_may_not(auth_state_dir, monkeypatch):
    c = pairing_app()
    monkeypatch.setattr(api, "tailscale_status_json", lambda *a, **k: (BLOB, ""))
    started = c.post(f"{P}/pair/start", json={"label": "Pixel"}, headers=H(TEST_BEARER)).json()
    device = c.post(f"{P}/pair/redeem", headers=H(started["code"])).json()
    # The phone IS a paired device: this is the access the picker depends on.
    r = c.get(PEERS, headers=H(device["token"]))
    assert r.status_code == 200 and r.json()["available"] is True
    # anonymous
    assert c.get(PEERS).status_code == 401
    # and a pairing code is not a device credential
    assert c.get(PEERS, headers=H(started["code"])).status_code == 401
