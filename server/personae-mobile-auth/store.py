"""Device-pairing credential store for the Personae Mobile auth provider.

One JSON file, ``state/credentials.json`` (mode 0600), shared by the two halves of this plugin that
run in the same dashboard process but are loaded as *different* modules:

* ``__init__.py`` — the ``DashboardAuthProvider`` (verify_token / verify_session);
* ``dashboard/plugin_api.py`` — the REST routes (pair/start, pair/redeem, devices, /pair page).

Both obtain THIS module through :func:`shared` below's ``sys.modules`` slot, so the in-memory pieces
(the rate limiter, the last-seen throttle, the parsed-file cache) are one object, not two.

Security shape
--------------
* Only ``sha256(token)`` and a 6-char display prefix are stored, never a token or a code.
* Comparisons are ``hmac.compare_digest`` over hex digests.
* Writes take ``fcntl.flock`` on a sidecar lock file, write a temp file in the same directory
  (0600), ``fsync`` it and ``os.replace`` it into place: a crash leaves the old file or the new one.
* A missing file is an empty store. A corrupt file FAILS CLOSED (no devices, no pending codes) and is
  logged; the next successful write replaces it (the bad copy is kept as ``.bad-<ts>``).
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import hmac
import json
import logging
import os
import secrets
import tempfile
import threading
import time
import math
from collections import Counter, deque
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("personae_mobile_auth.store")

VERSION = 1
PAIRING_TTL_SECONDS = 300
MAX_LIVE_PENDING = 5
#: Redeemed/expired codes are remembered (hashed) this long so a replay gets 410, not 401.
PENDING_RETENTION_SECONDS = 3600
MAX_PENDING_RECORDS = 50
LAST_SEEN_THROTTLE_SECONDS = 60
REDEEM_RATE_LIMIT = 5
REDEEM_RATE_WINDOW_SECONDS = 60
DEFAULT_LABEL = "Personae Mobile"
MAX_LABEL_CHARS = 80

_PLUGIN_DIR = Path(__file__).resolve().parent


# ---- entropy gate (moved here from __init__.py in 0.6.0 so the env bearer and minted device
# tokens are held to ONE bar; __init__ re-exports these names unchanged) ------------------------

# Fail-closed entropy bar, identical to the bundled drain provider: >=256-bit secret,
# enough distinct characters to reject degenerate values, distribution-aware guard.
_DEFAULT_MIN_SECRET_CHARS = 43
_MIN_DISTINCT_CHARS = 16
_MIN_SHANNON_BITS = 128.0


def _shannon_bits(value: str) -> float:
    """Total Shannon entropy (bits) of ``value`` over its character distribution."""
    if not value:
        return 0.0
    n = len(value)
    per_char = -sum((c / n) * math.log2(c / n) for c in Counter(value).values())
    return per_char * n


def assess_secret_strength(secret: str, *, min_chars: int = _DEFAULT_MIN_SECRET_CHARS) -> Optional[str]:
    """Human-readable rejection reason if ``secret`` is too weak, else ``None``."""
    if not secret:
        return "secret is empty"
    if len(secret) < min_chars:
        return (
            f"secret too short: {len(secret)} chars (need >= {min_chars}; "
            'use a >=256-bit value, e.g. `openssl rand -hex 32` or '
            '`python -c "import secrets; print(secrets.token_urlsafe(48))"`)')
    distinct = len(set(secret))
    if distinct < _MIN_DISTINCT_CHARS:
        return (f"secret has only {distinct} distinct characters "
                f"(need >= {_MIN_DISTINCT_CHARS}); looks structured/low-entropy")
    bits = _shannon_bits(secret)
    if bits < _MIN_SHANNON_BITS:
        return (f"secret entropy too low: {bits:.0f} bits (need >= {_MIN_SHANNON_BITS:.0f}); "
                "looks structured/repeated")
    return None


def _state_dir() -> Path:
    override = os.environ.get("PERSONAE_MOBILE_AUTH_STATE_DIR", "").strip()
    return Path(override) if override else _PLUGIN_DIR / "state"


def _cred_path() -> Path:
    return _state_dir() / "credentials.json"


def _empty() -> dict:
    return {"version": VERSION, "devices": [], "pending": []}


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def clean_label(label: Any) -> str:
    text = " ".join(str(label or "").split())[:MAX_LABEL_CHARS]
    return text or DEFAULT_LABEL


# ---- read path (cached by mtime/size; fail closed) ---------------------------------------------

_cache_lock = threading.Lock()
_cache: dict = {"key": None, "data": _empty()}


def _validate(raw: Any) -> dict:
    if not isinstance(raw, dict) or raw.get("version") != VERSION:
        raise ValueError("unexpected credentials.json shape/version")
    devices = raw.get("devices")
    pending = raw.get("pending")
    if not isinstance(devices, list) or not isinstance(pending, list):
        raise ValueError("devices/pending must be lists")
    for dev in devices:
        if not isinstance(dev, dict) or not isinstance(dev.get("token_sha256"), str) \
                or not isinstance(dev.get("id"), str):
            raise ValueError("malformed device record")
    for rec in pending:
        if not isinstance(rec, dict) or not isinstance(rec.get("code_sha256"), str):
            raise ValueError("malformed pending record")
    return raw


def _read_file(path: Path) -> dict:
    """Parse the store; missing -> empty; corrupt -> raises ValueError (callers decide)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _empty()
    return _validate(json.loads(text))


def load() -> dict:
    """The current store, fail-closed: a corrupt file reads as EMPTY (logged once per change)."""
    path = _cred_path()
    try:
        st = path.stat()
        key = (st.st_mtime_ns, st.st_size, st.st_ino)
    except FileNotFoundError:
        return _empty()
    except OSError as exc:
        logger.warning("personae-mobile-auth: cannot stat credentials store: %s", exc)
        return _empty()
    with _cache_lock:
        if _cache["key"] == key:
            return _cache["data"]
    try:
        data = _read_file(path)
    except (ValueError, OSError) as exc:
        logger.error("personae-mobile-auth: credentials store unreadable/corrupt (%s) — failing "
                     "closed: no device token or pairing code is accepted until it is repaired",
                     type(exc).__name__)
        data = _empty()
    with _cache_lock:
        _cache["key"] = key
        _cache["data"] = data
    return data


# ---- write path (flock + temp + fsync + os.replace) --------------------------------------------

_write_lock = threading.Lock()


@contextlib.contextmanager
def _flock():
    d = _state_dir()
    d.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(d, 0o700)
    lock_path = d / ".credentials.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        with _write_lock:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: dict) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".credentials.", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def update(fn: Callable[[dict], Any]) -> Any:
    """Run ``fn(data)`` under the exclusive lock on a fresh read, then persist. Returns fn's value.

    A corrupt file is moved aside to ``.bad-<ts>`` (loudly) and replaced by an empty store, so a
    write never silently resurrects a half-parsed state."""
    path = _cred_path()
    with _flock():
        try:
            data = _read_file(path)
        except (ValueError, OSError) as exc:
            bad = path.with_name(f"{path.name}.bad-{int(time.time())}")
            with contextlib.suppress(OSError):
                os.replace(path, bad)
            logger.error("personae-mobile-auth: corrupt credentials store moved to %s (%s); "
                         "starting empty", bad.name, type(exc).__name__)
            data = _empty()
        result = fn(data)
        _atomic_write(path, data)
    with _cache_lock:
        _cache["key"] = None
    return result


# ---- secrets ------------------------------------------------------------------------------------

def mint_secret(assess: Optional[Callable[[str], Optional[str]]] = None) -> str:
    """``secrets.token_urlsafe(32)`` (256 bits), re-drawn until it clears the same entropy bar the
    env bearer must clear (``assess`` returns a reason string when too weak)."""
    gate = assess or assess_secret_strength
    for _ in range(64):
        value = secrets.token_urlsafe(32)
        if gate(value) is None:
            return value
    raise RuntimeError("could not mint a secret that passes the entropy gate")


# ---- pairing ------------------------------------------------------------------------------------

def _prune_pending(data: dict, now: float) -> None:
    keep = []
    for rec in data["pending"]:
        done_at = rec.get("redeemed_at") or rec.get("expires_at") or 0
        if now - float(done_at) <= PENDING_RETENTION_SECONDS:
            keep.append(rec)
    data["pending"] = keep[-MAX_PENDING_RECORDS:]


def _is_live(rec: dict, now: float) -> bool:
    return not rec.get("redeemed_at") and float(rec.get("expires_at") or 0) > now


def start_pairing(label: Any, *, now: Optional[float] = None,
                  assess: Optional[Callable[[str], Optional[str]]] = None) -> dict:
    """Mint a single-use pairing code. Returns ``{"code", "label", "created_at", "expires_at"}``
    (epoch seconds); only the code's hash is stored. At most ``MAX_LIVE_PENDING`` live codes: the
    oldest live one is evicted (expired immediately) when a new one is minted."""
    now = time.time() if now is None else now
    code = mint_secret(assess)
    label = clean_label(label)
    rec = {"code_sha256": sha256_hex(code), "label": label, "created_at": now,
           "expires_at": now + PAIRING_TTL_SECONDS, "redeemed_at": None}

    def _apply(data: dict) -> None:
        _prune_pending(data, now)
        live = [r for r in data["pending"] if _is_live(r, now)]
        while len(live) >= MAX_LIVE_PENDING:
            oldest = live.pop(0)
            oldest["expires_at"] = now  # evicted: a replay of it reads as expired (410)
        data["pending"].append(rec)

    update(_apply)
    return {"code": code, "label": label, "created_at": int(now), "expires_at": int(rec["expires_at"])}


def _find_pending(data: dict, code: str) -> Optional[dict]:
    if not code:
        return None
    digest = sha256_hex(code)
    found = None
    for rec in data["pending"]:
        if hmac.compare_digest(digest, str(rec.get("code_sha256", ""))):
            found = rec
    return found


def classify_code(code: str, *, now: Optional[float] = None) -> Optional[str]:
    """``"pending"`` | ``"redeemed"`` | ``"expired"`` | ``None`` (unknown). Read-only."""
    now = time.time() if now is None else now
    rec = _find_pending(load(), code)
    if rec is None:
        return None
    if rec.get("redeemed_at"):
        return "redeemed"
    if float(rec.get("expires_at") or 0) <= now:
        return "expired"
    return "pending"


def redeem(code: str, *, now: Optional[float] = None,
           assess: Optional[Callable[[str], Optional[str]]] = None) -> tuple[str, Optional[dict]]:
    """Atomically redeem ``code``. Returns ``(outcome, result)``: ``("ok", {token, device_id, label,
    created_at})`` exactly once; otherwise ``("redeemed"|"expired"|"unknown", None)``. The check and
    the mark happen under one lock, so two racing redeems of the same code mint ONE device."""
    now = time.time() if now is None else now
    token = mint_secret(assess)

    def _apply(data: dict):
        rec = _find_pending(data, code)
        if rec is None:
            return "unknown", None
        if rec.get("redeemed_at"):
            return "redeemed", None
        if float(rec.get("expires_at") or 0) <= now:
            return "expired", None
        rec["redeemed_at"] = now
        device_id = "dev_" + secrets.token_hex(6)
        label = clean_label(rec.get("label"))
        data["devices"].append({
            "id": device_id, "label": label, "token_sha256": sha256_hex(token),
            "token_prefix": token[:6], "created_at": now, "last_seen_at": None,
            "revoked_at": None, "minted_by": "pairing"})
        _prune_pending(data, now)
        return "ok", {"token": token, "device_id": device_id, "label": label, "created_at": iso(now)}

    return update(_apply)


# ---- devices ------------------------------------------------------------------------------------

def find_device(token: str) -> Optional[dict]:
    """The NON-revoked device whose token hashes to ``sha256(token)``, else None (constant-time)."""
    if not token:
        return None
    digest = sha256_hex(token)
    match = None
    for dev in load()["devices"]:
        if hmac.compare_digest(digest, str(dev.get("token_sha256", ""))) and not dev.get("revoked_at"):
            match = dev
    return match


def has_active_devices() -> bool:
    return any(not d.get("revoked_at") for d in load()["devices"])


_seen_lock = threading.Lock()
_last_seen_written: dict[str, float] = {}


def touch(device_id: str, *, now: Optional[float] = None) -> bool:
    """Record ``last_seen_at``, at most once per ``LAST_SEEN_THROTTLE_SECONDS`` per device. Never
    raises (a full disk must not 500 an authenticated request)."""
    now = time.time() if now is None else now
    with _seen_lock:
        if now - _last_seen_written.get(device_id, 0.0) < LAST_SEEN_THROTTLE_SECONDS:
            return False
        _last_seen_written[device_id] = now

    def _apply(data: dict) -> None:
        for dev in data["devices"]:
            if dev.get("id") == device_id:
                dev["last_seen_at"] = now

    try:
        update(_apply)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("personae-mobile-auth: could not record last_seen_at: %s", type(exc).__name__)
        return False


def public_device(dev: dict) -> dict:
    """The listing shape: no hash, no prefix, no secret."""
    return {"id": dev.get("id"), "label": dev.get("label"),
            "created_at": iso(dev.get("created_at")), "last_seen_at": iso(dev.get("last_seen_at")),
            "revoked_at": iso(dev.get("revoked_at"))}


def list_devices() -> list[dict]:
    return [public_device(d) for d in load()["devices"]]


def revoke(device_id: str, *, now: Optional[float] = None) -> Optional[dict]:
    """Set ``revoked_at`` (idempotent). Returns the public record, or None for an unknown id."""
    now = time.time() if now is None else now

    def _apply(data: dict):
        for dev in data["devices"]:
            if dev.get("id") == device_id:
                if not dev.get("revoked_at"):
                    dev["revoked_at"] = now
                return public_device(dev)
        return None

    return update(_apply)


# ---- redeem rate limit (in-memory, per IP) ------------------------------------------------------

_rate_lock = threading.Lock()
_rate: dict[str, deque] = {}


def rate_limited(ip: str, *, now: Optional[float] = None) -> bool:
    """Count one redeem attempt from ``ip``; True when it exceeds ``REDEEM_RATE_LIMIT`` per window."""
    now = time.monotonic() if now is None else now
    with _rate_lock:
        q = _rate.setdefault(ip or "?", deque())
        while q and now - q[0] > REDEEM_RATE_WINDOW_SECONDS:
            q.popleft()
        q.append(now)
        if len(_rate) > 4096:  # bound memory under a spray of source addresses
            for key in list(_rate)[:1024]:
                _rate.pop(key, None)
        return len(q) > REDEEM_RATE_LIMIT


def reset_for_tests() -> None:
    with _rate_lock:
        _rate.clear()
    with _seen_lock:
        _last_seen_written.clear()
    with _cache_lock:
        _cache["key"] = None
        _cache["data"] = _empty()
