"""personae-mobile-auth 1.1.0 — pairing lifecycle, device tokens, entropy gate, state file.

Driven through the REAL dashboard auth middlewares (``token_auth_middleware`` outermost, then
``gated_auth_middleware``), in the same order ``web_server.py`` installs them, so the seam that
decides who reaches ``pair/redeem`` is the production one, not a mock.

The "browser" caller is a stand-in session provider (``provider="basic-standin"``) reached through
the bearer arm of the gate — a real cookie-session test needs the user's dashboard login.
"""
from __future__ import annotations

import json
import os
import stat
import threading
import time
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from conftest import AUTH_DIR, TEST_BEARER, load_module

from hermes_cli.dashboard_auth import Session, registry
from hermes_cli.dashboard_auth.base import DashboardAuthProvider, RefreshExpiredError
from hermes_cli.dashboard_auth.middleware import gated_auth_middleware
from hermes_cli.dashboard_auth.token_auth import clear_token_routes, token_auth_middleware

store = load_module("personae_mobile_auth_store", AUTH_DIR / "store.py")
plugin = load_module("pma_plugin_under_test", AUTH_DIR / "__init__.py")
api = load_module("pma_plugin_api_under_test", AUTH_DIR / "dashboard" / "plugin_api.py")

BROWSER = "browser-standin-session-token"
P = "/api/plugins/personae-mobile-auth"


class BrowserStandIn(DashboardAuthProvider):
    """Accepts one fixed opaque value as a session — stands in for a basic-auth cookie session."""
    name = "basic-standin"
    display_name = "Browser stand-in"
    supports_password = False

    def start_login(self, *, redirect_uri): raise NotImplementedError
    def complete_login(self, **_): raise NotImplementedError

    def verify_session(self, *, access_token):
        if access_token == BROWSER:
            return Session(user_id="admin", email="", display_name="admin", org_id="",
                           provider=self.name, expires_at=int(time.time()) + 600,
                           access_token=access_token, refresh_token="")
        return None

    def refresh_session(self, *, refresh_token): raise RefreshExpiredError("no")
    def revoke_session(self, *, refresh_token): return None


def make_app(secret=TEST_BEARER) -> TestClient:
    registry.clear_providers()
    clear_token_routes()
    app = FastAPI()
    app.state.auth_required = True

    @app.middleware("http")
    async def _gate(request: Request, call_next):
        return await gated_auth_middleware(request, call_next)

    @app.middleware("http")
    async def _seam(request: Request, call_next):  # registered last = runs first (as in core)
        return await token_auth_middleware(request, call_next)

    registry.register_provider(BrowserStandIn())
    registry.register_provider(plugin.PersonaeMobileProvider(secret=secret))
    plugin._register_token_routes()
    app.include_router(api.router, prefix=P)
    app.add_api_route("/pair", api.pair_page, methods=["GET"])

    @app.get("/api/profiles")
    async def profiles():
        return {"profiles": [{"name": f"p{i}"} for i in range(22)]}

    @app.get("/api/auth/me")
    async def me(request: Request):
        s = request.state.session
        return {"user_id": s.user_id, "provider": s.provider}

    @app.get("/api/profiles/sessions/sidebar")
    async def sidebar():
        return {"recents": []}

    return TestClient(app)


def H(token):
    return {"Authorization": f"Bearer {token}"}


def start(client, token=TEST_BEARER, label="the user's Pixel 8"):
    r = client.post(f"{P}/pair/start", json={"label": label}, headers=H(token))
    assert r.status_code == 200, r.text
    return r.json()


# ---- entropy gate + registration ----------------------------------------------------------------

def test_test_bearer_and_minted_tokens_clear_the_entropy_gate(auth_state_dir):
    assert plugin.assess_secret_strength(TEST_BEARER) is None
    for _ in range(20):
        assert plugin.assess_secret_strength(store.mint_secret()) is None
    assert plugin.assess_secret_strength("short") is not None
    assert plugin.assess_secret_strength("a" * 64) is not None
    with pytest.raises(ValueError):
        plugin.PersonaeMobileProvider(secret="weak-weak-weak")


class _Ctx:
    def __init__(self):
        self.registered = []

    def register_dashboard_auth_provider(self, p):
        self.registered.append(p)


def test_no_bearer_and_no_devices_skips_exactly_as_before(auth_state_dir, monkeypatch):
    monkeypatch.delenv(plugin.ENV_VAR, raising=False)
    ctx = _Ctx()
    plugin.register(ctx)
    assert ctx.registered == []
    assert plugin.LAST_SKIP_REASON.startswith("HERMES_PERSONAE_BEARER is not set. Set a >=256-bit value")
    monkeypatch.setenv(plugin.ENV_VAR, "too-weak")
    plugin.register(ctx)
    assert ctx.registered == [] and "rejected" in plugin.LAST_SKIP_REASON


def test_a_paired_device_keeps_the_provider_alive_without_an_env_bearer(auth_state_dir, monkeypatch):
    minted = store.start_pairing("x")
    assert store.redeem(minted["code"])[0] == "ok"
    monkeypatch.delenv(plugin.ENV_VAR, raising=False)
    ctx = _Ctx()
    plugin.register(ctx)
    assert len(ctx.registered) == 1 and ctx.registered[0]._secret is None
    # and a None secret never matches anything
    assert ctx.registered[0].verify_session(access_token="") is None
    assert ctx.registered[0].verify_session(access_token="None") is None


# ---- the lifecycle ------------------------------------------------------------------------------

def test_lifecycle_start_redeem_once_use_reuse_revoke(auth_state_dir):
    c = make_app()
    s = start(c)
    assert set(s) >= {"code", "expires_at", "deep_link", "qr_svg_url", "poll_url"}
    assert s["expires_at"] - time.time() <= 300 and s["expires_at"] - time.time() > 290
    link = urlparse(s["deep_link"])
    assert link.scheme == "personae" and link.netloc == "connect"
    q = parse_qs(link.query)
    assert q["code"] == [s["code"]] and unquote(q["base"][0]) == "http://testserver"
    assert q["label"] == ["the user's Pixel 8"] and int(q["expires"][0]) == s["expires_at"]

    r = c.post(f"{P}/pair/redeem", headers=H(s["code"]))
    assert r.status_code == 200, r.text
    dev = r.json()
    assert set(dev) == {"base_url", "token", "device_id", "label", "created_at"}
    assert dev["label"] == "the user's Pixel 8" and dev["base_url"] == "http://testserver"
    token = dev["token"]
    assert plugin.assess_secret_strength(token) is None

    # reused -> 410
    r2 = c.post(f"{P}/pair/redeem", headers=H(s["code"]))
    assert r2.status_code == 410 and r2.json()["error"] == "code_used"

    # the device token works like the bearer: session routes AND the token route
    assert c.get("/api/profiles", headers=H(token)).status_code == 200
    assert len(c.get("/api/profiles", headers=H(token)).json()["profiles"]) == 22
    me = c.get("/api/auth/me", headers=H(token)).json()
    assert me == {"user_id": f"personae-mobile:{dev['device_id']}", "provider": "personae-mobile"}
    assert c.get("/api/profiles/sessions/sidebar", headers=H(token)).status_code == 200

    # revoke (by the owner) -> 401 immediately, everywhere
    r3 = c.post(f"{P}/devices/{dev['device_id']}/revoke", headers=H(TEST_BEARER))
    assert r3.status_code == 200 and r3.json()["device"]["revoked_at"]
    assert c.get("/api/profiles", headers=H(token)).status_code == 401
    assert c.get("/api/auth/me", headers=H(token)).status_code == 401
    assert c.get("/api/profiles/sessions/sidebar", headers=H(token)).status_code == 401


def test_expired_code_is_410(auth_state_dir):
    c = make_app()
    old = store.start_pairing("late", now=time.time() - 301)
    r = c.post(f"{P}/pair/redeem", headers=H(old["code"]))
    assert r.status_code == 410 and r.json()["error"] == "code_expired"


def test_unknown_or_absent_code_is_401(auth_state_dir):
    c = make_app()
    assert c.post(f"{P}/pair/redeem").status_code == 401
    assert c.post(f"{P}/pair/redeem", headers=H(store.mint_secret())).status_code == 401
    # the env bearer is not a pairing code either
    assert c.post(f"{P}/pair/redeem", headers=H(TEST_BEARER)).status_code == 401


def test_a_pairing_code_is_a_credential_on_the_redeem_path_only(auth_state_dir):
    c = make_app()
    s = start(c)
    code = s["code"]
    assert c.get("/api/profiles", headers=H(code)).status_code == 401          # verify_session
    assert c.get("/api/auth/me", headers=H(code)).status_code == 401
    assert c.get("/api/profiles/sessions/sidebar", headers=H(code)).status_code == 401  # other token route
    assert c.get(f"{P}/devices", headers=H(code)).status_code == 401
    assert c.post(f"{P}/pair/start", headers=H(code)).status_code == 401
    # ...and it is still redeemable afterwards (those probes did not burn it)
    assert c.post(f"{P}/pair/redeem", headers=H(code)).status_code == 200


def test_redeem_is_rate_limited_per_ip(auth_state_dir):
    c = make_app()
    codes = [store.mint_secret() for _ in range(6)]
    statuses = [c.post(f"{P}/pair/redeem", headers=H(x)).status_code for x in codes]
    assert statuses[:5] == [401] * 5
    assert statuses[5] == 429
    r = c.post(f"{P}/pair/redeem", headers=H(start(c)["code"]))
    assert r.status_code == 429 and r.headers.get("retry-after") == "60"


def test_single_use_race_mints_exactly_one_device(auth_state_dir):
    minted = store.start_pairing("race")
    outcomes = []
    barrier = threading.Barrier(8)

    def go():
        barrier.wait()
        outcomes.append(store.redeem(minted["code"])[0])

    threads = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(outcomes) == ["ok"] + ["redeemed"] * 7
    assert len(store.load()["devices"]) == 1


def test_live_pending_codes_are_capped(auth_state_dir):
    codes = [store.start_pairing(f"n{i}")["code"] for i in range(7)]
    live = [x for x in codes if store.classify_code(x) == "pending"]
    assert live == codes[-5:]
    assert store.classify_code(codes[0]) == "expired"  # evicted -> a replay reads 410, not 401


# ---- who may do what ----------------------------------------------------------------------------

def test_device_tokens_cannot_administer_but_can_revoke_themselves(auth_state_dir):
    c = make_app()
    a = c.post(f"{P}/pair/redeem", headers=H(start(c)["code"])).json()
    b = c.post(f"{P}/pair/redeem", headers=H(start(c)["code"])).json()
    assert c.post(f"{P}/pair/start", headers=H(a["token"])).status_code == 403
    assert c.get(f"{P}/devices", headers=H(a["token"])).status_code == 403
    assert c.post(f"{P}/devices/{b['device_id']}/revoke", headers=H(a["token"])).status_code == 403
    me = c.get(f"{P}/devices/self", headers=H(a["token"]))
    assert me.status_code == 200 and me.json()["device"]["id"] == a["device_id"]
    assert c.post(f"{P}/devices/{a['device_id']}/revoke", headers=H(a["token"])).status_code == 200
    assert c.get("/api/profiles", headers=H(a["token"])).status_code == 401
    assert c.get("/api/profiles", headers=H(b["token"])).status_code == 200


def test_browser_session_lists_devices_without_secrets(auth_state_dir):
    c = make_app()
    dev = c.post(f"{P}/pair/redeem", headers=H(start(c, token=BROWSER)["code"])).json()
    r = c.get(f"{P}/devices", headers=H(BROWSER))
    assert r.status_code == 200
    body = r.text
    assert dev["token"] not in body and dev["token"][:6] not in body
    assert "sha256" not in body and "prefix" not in body
    (row,) = r.json()["devices"]
    assert set(row) == {"id", "label", "created_at", "last_seen_at", "revoked_at"}
    assert c.post(f"{P}/devices/nope/revoke", headers=H(BROWSER)).status_code == 404
    assert c.get(f"{P}/devices").status_code == 401  # anonymous


def test_pair_page_qr_and_status(auth_state_dir):
    c = make_app()
    page = c.get("/pair?app=1&label=Pixel", headers=H(BROWSER))
    assert page.status_code == 200
    assert "Autorizar Personae Mobile" in page.text and "personae://connect?base=" in page.text
    assert page.headers["cache-control"] == "no-store"
    started = start(c, token=BROWSER)
    svg = c.get(started["qr_svg_url"], headers=H(BROWSER))
    assert svg.status_code == 200 and svg.text.startswith("<svg") and started["code"] not in svg.text
    assert started["code"] not in started["qr_svg_url"] and started["code"] not in started["poll_url"]
    assert c.get(started["poll_url"], headers=H(BROWSER)).json()["state"] == "pending"
    c.post(f"{P}/pair/redeem", headers=H(started["code"]))
    assert c.get(started["poll_url"], headers=H(BROWSER)).json()["state"] == "redeemed"
    assert c.get(started["qr_svg_url"]).status_code == 401  # anonymous
    anon = c.get("/pair", follow_redirects=False)  # the real gate: HTML page -> login with next
    assert anon.status_code == 302 and anon.headers["location"] == "/login?next=%2Fpair"
    anon = c.get("/pair?app=1", follow_redirects=False)
    assert anon.headers["location"] == "/login?next=%2Fpair%3Fapp%3D1"


# ---- the state file -----------------------------------------------------------------------------

def test_state_file_is_0600_and_holds_no_plaintext(auth_state_dir):
    c = make_app()
    s = start(c)
    dev = c.post(f"{P}/pair/redeem", headers=H(s["code"])).json()
    path = auth_state_dir / "credentials.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    raw = path.read_text()
    assert s["code"] not in raw and dev["token"] not in raw and TEST_BEARER not in raw
    data = json.loads(raw)
    assert data["version"] == 1 and data["devices"][0]["token_prefix"] == dev["token"][:6]
    assert data["devices"][0]["minted_by"] == "pairing"


def test_corrupt_state_fails_closed_and_is_quarantined_on_write(auth_state_dir, monkeypatch):
    c = make_app()
    dev = c.post(f"{P}/pair/redeem", headers=H(start(c)["code"])).json()
    path = auth_state_dir / "credentials.json"
    path.write_text("{not json")
    assert store.find_device(dev["token"]) is None
    assert c.get("/api/profiles", headers=H(dev["token"])).status_code == 401
    # env bearer unaffected by a broken store
    assert c.get("/api/profiles", headers=H(TEST_BEARER)).status_code == 200
    # registration still works (env bearer present) and does not crash on the broken file
    monkeypatch.setenv(plugin.ENV_VAR, TEST_BEARER)
    ctx = _Ctx()
    plugin.register(ctx)
    assert len(ctx.registered) == 1
    store.start_pairing("after")  # a write quarantines the bad file and starts clean
    assert any(p.name.startswith("credentials.json.bad-") for p in auth_state_dir.iterdir())
    assert json.loads(path.read_text())["version"] == 1


def test_last_seen_is_throttled(auth_state_dir):
    minted = store.start_pairing("seen")
    _, dev = store.redeem(minted["code"])
    t0 = time.time()
    assert store.touch(dev["device_id"], now=t0) is True
    assert store.touch(dev["device_id"], now=t0 + 10) is False
    assert store.touch(dev["device_id"], now=t0 + 61) is True
