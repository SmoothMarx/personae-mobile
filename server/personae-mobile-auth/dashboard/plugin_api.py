"""Personae Mobile — browser-mediated device pairing (REST half of ``personae-mobile-auth``).

Mounted by the dashboard at ``/api/plugins/personae-mobile-auth/`` (plugin REST mount), plus ONE
root page, ``GET /pair``, added to the app at import time (see :func:`_mount_pair_page`).

Flow
----
1. A logged-in browser (cookie session) opens ``/pair`` — or the phone's in-app browser opens
   ``/login?next=/pair`` and lands there after signing in. The page mints a single-use, 300 s
   pairing code (``POST pair/start`` does the same as JSON) and shows a QR + a ``personae://``
   deep link + a "Continuar" button that navigates to it.
2. The phone (no cookie) calls ``POST pair/redeem`` with ``Authorization: Bearer <code>``. That
   exact path is a registered *token route*; the provider's ``verify_token`` accepts a known
   pairing code ONLY there, so the request reaches this handler with a ``personae-pair`` principal
   and nothing else gets in. Valid -> a device token, exactly once. Reused/expired -> 410.
   Unknown/absent -> 401 (from the token seam). >5/min/IP -> 429.
3. The device token then authenticates every app call like the env bearer did, until revoked.

Who may do what
---------------
* browser cookie session (provider != personae-mobile) — start pairing, list, revoke any device;
* the env bearer (``HERMES_PERSONAE_BEARER``) — the owner's static credential: same as a browser
  (this is also what lets the pairing lifecycle be exercised headless);
* a device token — may read and revoke ITSELF only (403 otherwise);
* a pairing code — may only redeem.

No secret is ever logged. Codes and tokens are returned to the caller once and stored hashed.
"""
from __future__ import annotations

import html
import importlib.util
import json
import logging
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

logger = logging.getLogger("personae_mobile_auth.api")

PROVIDER = "personae-mobile"
PRINCIPAL = "personae-mobile"
SCOPE_PAIR = "personae-pair"
SCOPE_PAIR_RATE_LIMITED = "personae-pair-ratelimited"
API_PREFIX = "/api/plugins/personae-mobile-auth"
PAIR_PAGE_PATH = "/pair"
DEEP_LINK_SCHEME = "personae://connect"

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer"}

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, filename: str):
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, _PLUGIN_ROOT / filename)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


store = _load("personae_mobile_auth_store", "store.py")
qr = _load("personae_mobile_auth_qr", "qr.py")

router = APIRouter()


# ---- audit (best effort; never a secret) --------------------------------------------------------

def _audit(outcome: str, request: Request, **fields: Any) -> None:
    try:
        from hermes_cli.dashboard_auth.audit import AuditEvent, audit_log
        event = {
            "pair_started": AuditEvent.NATIVE_AUTHORIZE_START,
            "pair_redeemed": AuditEvent.NATIVE_TOKEN_SUCCESS,
            "device_revoked": AuditEvent.REVOKE,
        }.get(outcome, AuditEvent.NATIVE_TOKEN_FAILURE)
        audit_log(event, provider=PROVIDER, reason=outcome, ip=_client_ip(request), **fields)
    except Exception:  # noqa: BLE001 — auditing must never break a request
        logger.info("personae-mobile-auth: %s", outcome)


def _client_ip(request: Request) -> str:
    try:
        from hermes_cli.dashboard_auth.request_utils import client_ip
        return client_ip(request)
    except Exception:  # pragma: no cover
        return request.client.host if request.client else ""


def _bearer(request: Request) -> str:
    parts = request.headers.get("authorization", "").split(" ", 1)
    if len(parts) == 2 and parts[0].strip().lower() == "bearer":
        return parts[1].strip()
    return ""


# ---- caller classification ----------------------------------------------------------------------

def _caller(request: Request) -> tuple[str, Optional[str]]:
    """``("browser"|"env"|"device"|"none", device_id)`` from what the auth gate attached."""
    sess = getattr(request.state, "session", None)
    if sess is not None:
        if getattr(sess, "provider", "") != PROVIDER:
            return "browser", None
        user = str(getattr(sess, "user_id", ""))
        if user == PRINCIPAL:
            return "env", None
        if user.startswith(PRINCIPAL + ":"):
            return "device", user.split(":", 1)[1]
    principal = getattr(request.state, "token_principal", None)
    if principal is not None and getattr(principal, "provider", "") == PROVIDER:
        name = str(principal.principal)
        if name == PRINCIPAL:
            return "env", None
        if name.startswith(PRINCIPAL + ":"):
            return "device", name.split(":", 1)[1]
    return "none", None


def _is_owner(kind: str) -> bool:
    return kind in ("browser", "env")


def _err(status: int, error: str, detail: str, headers: Optional[dict] = None) -> JSONResponse:
    return JSONResponse({"error": error, "detail": detail}, status_code=status,
                        headers={**_NO_STORE, **(headers or {})})


def _base_url(request: Request) -> str:
    """The origin the CALLER used (so a deep link minted over the tailnet points at the tailnet)."""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        host = request.url.netloc
    return f"{proto}://{host}"


# ---- live-code registry (MEMORY ONLY: lets the page's <img> and poll reference a code by a
# non-secret id, so no URL — and therefore no access log — ever carries the code) -------------------

_live_lock = threading.Lock()
_live: dict[str, dict] = {}


def _remember(pair_id: str, entry: dict) -> None:
    now = time.time()
    with _live_lock:
        for key in [k for k, v in _live.items() if v["expires_at"] + 60 < now]:
            _live.pop(key, None)
        _live[pair_id] = entry


def _lookup(pair_id: str) -> Optional[dict]:
    with _live_lock:
        return _live.get(pair_id)


def deep_link(base_url: str, code: str, label: str, expires_at: int) -> str:
    return (f"{DEEP_LINK_SCHEME}?base={quote(base_url, safe='')}&code={quote(code, safe='')}"
            f"&label={quote(label, safe='')}&expires={int(expires_at)}")


def _start(request: Request, label: Any) -> dict:
    minted = store.start_pairing(label)
    base = _base_url(request)
    link = deep_link(base, minted["code"], minted["label"], minted["expires_at"])
    pair_id = store.sha256_hex(minted["code"])[:20]
    _remember(pair_id, {"deep_link": link, "expires_at": minted["expires_at"],
                        "code_sha256": store.sha256_hex(minted["code"]), "label": minted["label"]})
    _audit("pair_started", request, user_id=_caller(request)[0])
    return {
        "code": minted["code"],
        "label": minted["label"],
        "expires_at": minted["expires_at"],
        "ttl_seconds": store.PAIRING_TTL_SECONDS,
        "base_url": base,
        "deep_link": link,
        "pair_id": pair_id,
        "qr_svg_url": f"{API_PREFIX}/pair/qr.svg?{urlencode({'id': pair_id})}",
        "poll_url": f"{API_PREFIX}/pair/status?{urlencode({'id': pair_id})}",
    }


# ---- routes -------------------------------------------------------------------------------------

@router.get("/health")
async def health() -> dict:
    return {"ok": True, "plugin": "personae-mobile-auth", "pairing": True,
            "pair_page": PAIR_PAGE_PATH, "deep_link_scheme": DEEP_LINK_SCHEME}


@router.post("/pair/start")
async def pair_start(request: Request):
    kind, _ = _caller(request)
    if not _is_owner(kind):
        return _err(403 if kind == "device" else 401, "forbidden",
                    "Pairing must be started from a signed-in dashboard session.")
    label: Any = None
    try:
        body = await request.json()
        if isinstance(body, dict):
            label = body.get("label")
    except Exception:  # noqa: BLE001 — an empty/non-JSON body means "default label"
        label = None
    return JSONResponse(_start(request, label), headers=_NO_STORE)


@router.post("/pair/redeem")
async def pair_redeem(request: Request):
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ()) or ()) if principal is not None else ()
    if SCOPE_PAIR_RATE_LIMITED in scopes:
        _audit("pair_rate_limited", request)
        return _err(429, "rate_limited", "Too many pairing attempts from this address. Wait a "
                    "minute and try again.", {"Retry-After": "60"})
    if principal is None or getattr(principal, "provider", "") != PROVIDER or SCOPE_PAIR not in scopes:
        _audit("pair_no_code", request)
        return _err(401, "unauthenticated", "A pairing code is required (Authorization: Bearer <code>).")
    code = _bearer(request)
    outcome, result = store.redeem(code)
    if outcome == "ok":
        _audit("pair_redeemed", request, user_id=f"{PRINCIPAL}:{result['device_id']}")
        return JSONResponse({"base_url": _base_url(request), **result}, headers=_NO_STORE)
    if outcome == "redeemed":
        _audit("pair_code_reused", request)
        return _err(410, "code_used", "This pairing code was already used. Start a new pairing "
                    "on the dashboard.")
    if outcome == "expired":
        _audit("pair_code_expired", request)
        return _err(410, "code_expired", "This pairing code expired. Start a new pairing on the "
                    "dashboard.")
    _audit("pair_code_unknown", request)
    return _err(401, "unauthenticated", "Unknown pairing code.")


@router.get("/pair/status")
async def pair_status(request: Request, id: str = ""):  # noqa: A002 — query name is the contract
    kind, _ = _caller(request)
    if not _is_owner(kind):
        return _err(403 if kind == "device" else 401, "forbidden", "Owner session required.")
    entry = _lookup(id)
    if entry is None:
        return _err(404, "not_found", "Unknown or forgotten pairing id.")
    state, label = "expired", entry["label"]
    for rec in store.load()["pending"]:
        if rec.get("code_sha256") == entry["code_sha256"]:
            if rec.get("redeemed_at"):
                state = "redeemed"
            elif float(rec.get("expires_at") or 0) > time.time():
                state = "pending"
    return JSONResponse({"state": state, "label": label, "expires_at": entry["expires_at"]},
                        headers=_NO_STORE)


@router.get("/pair/qr.svg")
async def pair_qr(request: Request, id: str = ""):  # noqa: A002
    kind, _ = _caller(request)
    if not _is_owner(kind):
        return _err(403 if kind == "device" else 401, "forbidden", "Owner session required.")
    entry = _lookup(id)
    if entry is None:
        return _err(404, "not_found", "Unknown or forgotten pairing id.")
    return Response(qr.to_svg(entry["deep_link"]), media_type="image/svg+xml", headers=_NO_STORE)


@router.get("/devices")
async def devices(request: Request):
    kind, _ = _caller(request)
    if not _is_owner(kind):
        return _err(403 if kind == "device" else 401, "forbidden", "Owner session required.")
    return JSONResponse({"devices": store.list_devices()}, headers=_NO_STORE)


@router.get("/devices/self")
async def device_self(request: Request):
    kind, device_id = _caller(request)
    if kind != "device":
        return _err(404, "not_a_device", "This credential is not a paired device.")
    for dev in store.list_devices():
        if dev["id"] == device_id:
            return JSONResponse({"device": dev}, headers=_NO_STORE)
    return _err(404, "not_found", "Device not found.")


@router.post("/devices/{device_id}/revoke")
async def device_revoke(request: Request, device_id: str):
    kind, own_id = _caller(request)
    if not (_is_owner(kind) or (kind == "device" and own_id == device_id)):
        return _err(403 if kind == "device" else 401, "forbidden",
                    "Only the owner, or the device itself, may revoke it.")
    record = store.revoke(device_id)
    if record is None:
        return _err(404, "not_found", "Device not found.")
    _audit("device_revoked", request, user_id=f"{PRINCIPAL}:{device_id}", by=kind)
    return JSONResponse({"device": record}, headers=_NO_STORE)


# ---- the tailnet peer list (0.7.0) --------------------------------------------------------------
#
# WHY THIS LIVES ON THE HOST: a phone cannot enumerate a tailnet. Android exposes no such API, and
# `src/native/tailscale.ts` deliberately bridges only six calls (installed / connect / disconnect /
# openApp / vpnTransportActive / probeTcp) — no status. The HOST can, and does:
#
#     $ tailscale status --json      -> {"Self": {...}, "Peer": {"key": {...}, ...}}
#
# So the picker's source of truth is this owner-or-device-gated endpoint. It is read by the PHONE,
# which is a paired device — gating it owner-only would make it useless — so the gate is
# "owner OR paired device", exactly like `/devices/self`.
#
# The endpoint NEVER fails hard: no CLI, a timeout, a non-zero exit or an unparseable blob all
# answer `{"available": false, "reason": ...}`, which the app renders as "type the address by hand"
# (the manual entry under Advanced). That is a pass for the release, not a defect.

TAILSCALE_BIN = "tailscale"
TAILSCALE_TIMEOUT_SECONDS = 5.0

#: A reason string the caller may see. Never contains a path, a token or any output of the CLI.
TAILSCALE_REASONS = ("cli_missing", "timeout", "cli_error", "unparseable_output")


def tailscale_status_json(
    binary: str = TAILSCALE_BIN, timeout: float = TAILSCALE_TIMEOUT_SECONDS
) -> tuple[str, str]:
    """Run ``tailscale status --json``. Returns ``(payload, reason)``; ``reason == ""`` on success.

    The reason vocabulary is small and closed, and the CLI's own stderr/stdout is never returned —
    it can carry tailnet names, and this response is read by a phone.
    """
    try:
        proc = subprocess.run(
            [binary, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return "", "cli_missing"
    except subprocess.TimeoutExpired:
        return "", "timeout"
    except OSError:
        return "", "cli_missing"
    if proc.returncode != 0:
        return "", "cli_error"
    return proc.stdout or "", ""


def _ipv4_of(node: dict) -> str:
    """The first IPv4 in ``TailscaleIPs``, or ``""``. IPv6-only peers are dropped, per the brief."""
    for value in node.get("TailscaleIPs") or []:
        text = str(value or "").strip()
        if ":" in text:
            continue
        octets = text.split(".")
        if len(octets) == 4 and all(part.isdigit() and int(part) <= 255 for part in octets):
            return text
    return ""


def _peer_row(node: dict) -> Optional[dict]:
    ip = _ipv4_of(node)
    if not ip:
        return None
    name = str(node.get("HostName") or "").strip()
    if not name:
        # DNSName is `host.tailnet.ts.net.` — the first label is the same host name the CLI prints.
        name = str(node.get("DNSName") or "").split(".")[0].strip()
    return {
        "name": name,
        "ip": ip,
        "os": str(node.get("OS") or "").strip(),
        "online": bool(node.get("Online")),
    }


def peers_payload(payload: str, reason: str = "") -> dict:
    """Turn the CLI's blob into the app's shape, or into an honest ``available: false``.

    ``{"available": true, "self": {name, ip, os, online}, "peers": [{name, ip, os, online}, ...]}``
    — peers sorted by name so two calls cannot reorder the picker, IPv6-only peers dropped.
    """
    if reason:
        return {"available": False, "reason": reason if reason in TAILSCALE_REASONS else "cli_error"}
    try:
        data = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return {"available": False, "reason": "unparseable_output"}
    if not isinstance(data, dict) or not isinstance(data.get("Self"), dict):
        return {"available": False, "reason": "unparseable_output"}
    self_row = _peer_row(data["Self"])
    if self_row is None:
        # A running tailnet always has an IPv4 for itself; without one the blob is not usable.
        return {"available": False, "reason": "unparseable_output"}
    raw_peers = data.get("Peer")
    peers: list[dict] = []
    if isinstance(raw_peers, dict):
        for node in raw_peers.values():
            if not isinstance(node, dict):
                continue
            row = _peer_row(node)
            if row is not None:
                peers.append(row)
    elif isinstance(raw_peers, list):
        for node in raw_peers:
            if isinstance(node, dict):
                row = _peer_row(node)
                if row is not None:
                    peers.append(row)
    peers.sort(key=lambda row: (row["name"].lower(), row["ip"]))
    return {"available": True, "self": self_row, "peers": peers}


@router.get("/tailscale/peers")
async def tailscale_peers(request: Request):
    """The machines this host can see on its tailnet. Owner session OR a paired device."""
    kind, _ = _caller(request)
    if kind == "none":
        return _err(401, "unauthenticated", "A dashboard session or a paired device is required.")
    payload, reason = tailscale_status_json()
    return JSONResponse(peers_payload(payload, reason), headers=_NO_STORE)


# ---- the /pair page -----------------------------------------------------------------------------

_PAGE_CSS = """
:root{--bg:#170d02;--mid:#ffac02;--fg:#fff;--hair:color-mix(in srgb,#ffac02 18%,transparent)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);
font-family:'Collapse',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
@font-face{font-family:'Collapse';src:url('/fonts/Collapse-Regular.woff2') format('woff2')}
@font-face{font-family:'Rules Compressed';font-weight:600;src:url('/fonts/RulesCompressed-Medium.woff2') format('woff2')}
body{display:grid;place-items:center;padding:clamp(1rem,5vh,4rem) 1rem;
background-image:radial-gradient(ellipse at top,color-mix(in srgb,var(--mid) 6%,transparent) 0%,transparent 55%)}
main{width:100%;max-width:26rem}
.brand{text-align:center;margin-bottom:1.25rem;font-family:'Rules Compressed','Collapse',sans-serif;
font-weight:600;letter-spacing:.32em;text-transform:uppercase;color:var(--mid)}
.card{padding:1.75rem 1.5rem;background:color-mix(in srgb,#fff 2%,var(--bg));border:1px solid var(--hair)}
h1{margin:0 0 .3rem;font-family:'Rules Compressed','Collapse',sans-serif;font-weight:600;
font-size:1.6rem;letter-spacing:.05em;text-transform:uppercase}
.sub{margin:0 0 1.25rem;color:color-mix(in srgb,var(--fg) 65%,transparent);font-size:.92rem}
.btn{display:block;width:100%;text-align:center;padding:.85rem 1rem;margin:.5rem 0;background:var(--mid);
color:#170d02;font-weight:700;text-decoration:none;border:0;font-size:1rem;cursor:pointer;
text-transform:uppercase;letter-spacing:.08em}
.btn.secondary{background:transparent;color:var(--mid);border:1px solid var(--hair)}
.qr{display:block;margin:1rem auto;width:100%;max-width:260px;background:#fff;padding:0}
label{display:block;font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;
color:color-mix(in srgb,var(--fg) 70%,transparent);margin:.75rem 0 .25rem}
input,textarea{width:100%;padding:.6rem;background:#0d0701;color:var(--fg);border:1px solid var(--hair);
font:inherit;font-size:.85rem}
textarea{height:5.2rem;resize:none;word-break:break-all}
.row{display:flex;gap:.5rem}.row>*{flex:1}
.muted{font-size:.8rem;color:color-mix(in srgb,var(--fg) 55%,transparent)}
.ok{color:#6ee7a8;font-weight:700}.warn{color:#ffb4a2}
details{margin-top:1rem}summary{cursor:pointer;color:var(--mid)}
"""

_PAGE_JS = """
(function(){
  var exp = %(expires)d * 1000, poll = %(poll)s, el = document.getElementById('countdown');
  var st = document.getElementById('status');
  function tick(){
    var left = Math.max(0, Math.round((exp - Date.now())/1000));
    el.textContent = left > 0 ? ('Expira em ' + Math.floor(left/60) + ':' + ('0'+(left%%60)).slice(-2))
                              : 'Código expirado — gera um novo.';
    if (left <= 0) { el.className = 'muted warn'; return; }
    setTimeout(tick, 1000);
  }
  tick();
  function check(){
    fetch(poll, {credentials:'same-origin', cache:'no-store'}).then(function(r){return r.json()})
      .then(function(d){
        if (d && d.state === 'redeemed') { st.textContent = '✓ Telefone emparelhado: ' + d.label; st.className='ok'; return; }
        if (Date.now() < exp) setTimeout(check, 2000);
      }).catch(function(){ if (Date.now() < exp) setTimeout(check, 4000); });
  }
  setTimeout(check, 2000);
  var copy = document.getElementById('copy');
  if (copy) copy.addEventListener('click', function(){
    var t = document.getElementById('link'); t.select();
    try { navigator.clipboard.writeText(t.value); } catch (e) { document.execCommand('copy'); }
    copy.textContent = 'Copiado';
  });
})();
"""


def render_pair_page(started: dict, *, in_app: bool) -> str:
    e = html.escape
    link = started["deep_link"]
    qr_block = (f'<img class="qr" alt="Código QR de emparelhamento" src="{e(started["qr_svg_url"])}">'
                '<p class="muted">Na app: <b>Definições → Ler código QR</b>.</p>')
    continue_btn = (f'<a class="btn" href="{e(link)}" id="continue">Continuar na app</a>'
                    '<p class="muted">Abre a Personae Mobile e conclui o emparelhamento.</p>')
    middle = (continue_btn + f"<details><summary>Mostrar código QR</summary>{qr_block}</details>"
              if in_app else qr_block + continue_btn)
    js = _PAGE_JS % {"expires": int(started["expires_at"]),
                     "poll": __import__("json").dumps(started["poll_url"])}
    return f"""<!doctype html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Autorizar Personae Mobile — Hermes</title><style>{_PAGE_CSS}</style></head>
<body><main><div class="brand">Hermes · Agent</div><div class="card">
<h1>Autorizar Personae Mobile</h1>
<p class="sub">Liga um telefone a este dashboard sem copiar chaves. O código vale
{store.PAIRING_TTL_SECONDS // 60} minutos e só pode ser usado uma vez.
<br><span class="muted">Authorize a phone for this dashboard — single use, 5 minutes.</span></p>
<form method="get" action="{PAIR_PAGE_PATH}">
<label for="label">Nome do dispositivo</label>
<div class="row"><input id="label" name="label" maxlength="{store.MAX_LABEL_CHARS}" value="{e(started['label'])}">
{'<input type="hidden" name="app" value="1">' if in_app else ''}
<button class="btn secondary" type="submit" style="flex:0 0 auto;width:auto;margin:0">Novo código</button></div>
</form>
{middle}
<label for="link">Ligação (deep link)</label>
<textarea id="link" readonly>{e(link)}</textarea>
<button class="btn secondary" id="copy" type="button">Copiar ligação</button>
<p id="countdown" class="muted"></p><p id="status" class="muted">À espera do telefone…</p>
</div></main><script>{js}</script></body></html>"""


async def pair_page(request: Request):
    kind, _ = _caller(request)
    if not _is_owner(kind):
        # The auth gate already redirected an anonymous browser to /login?next=/pair; reaching here
        # unauthenticated means loopback/insecure mode or a device token.
        return HTMLResponse("<!doctype html><p>Inicia sessão no dashboard para emparelhar um telefone "
                            "(<a href='/login?next=%2Fpair'>entrar</a>).</p>", status_code=403,
                            headers=_NO_STORE)
    params = request.query_params
    started = _start(request, params.get("label"))
    in_app = params.get("app") == "1"
    return HTMLResponse(render_pair_page(started, in_app=in_app), headers=_NO_STORE)


def _mount_pair_page() -> bool:
    """Add ``GET /pair`` to the dashboard app.

    A plugin router is mounted under ``/api/plugins/<id>/``, and the login redirect refuses any
    ``/api/*`` target (``is_safe_next_path``), so the post-login landing page must live at a root
    path. The dashboard imports plugin APIs BEFORE it mounts the SPA catch-all
    (``web_server.py``: ``_mount_plugin_api_routes()`` then ``mount_spa(app)``), so a route added
    here wins over the SPA for exactly this path. The auth gate still guards it like any page
    (anonymous -> 302 ``/login?next=%2Fpair``). Failure is logged, never fatal.
    """
    web_server = sys.modules.get("hermes_cli.web_server")
    if web_server is None:
        # Imported outside a dashboard boot (tests, tooling): never import the whole web server
        # just to add a page. Tests mount ``pair_page`` on their own app.
        return False
    try:
        app = web_server.app  # partially-initialised module: ``app`` already exists
    except Exception as exc:  # noqa: BLE001
        logger.warning("personae-mobile-auth: /pair page not mounted (%s)", type(exc).__name__)
        return False
    if any(getattr(r, "path", None) == PAIR_PAGE_PATH for r in app.router.routes):
        return True
    app.add_api_route(PAIR_PAGE_PATH, pair_page, methods=["GET"], include_in_schema=False,
                      response_class=HTMLResponse)
    logger.info("personae-mobile-auth: mounted %s", PAIR_PAGE_PATH)
    return True


PAIR_PAGE_MOUNTED = _mount_pair_page()
