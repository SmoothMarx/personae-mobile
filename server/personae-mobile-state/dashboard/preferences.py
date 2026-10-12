"""The per-user preference document (Phase A of 0.9.0) — pure logic, no FastAPI, no HTTP.

WHY A DOCUMENT AND NOT A SECOND STATE STORE
-------------------------------------------
The messenger plugin's ``state/ui-state.json`` is a *layout* store: seven named keys, each an object
whose top-level names are merged entry-wise by ``rev``. It is the right home for the roster's shape
(sections, session groups, colours, hidden, sort) and it stays that home.

This file is a different thing: **one small per-profile document of portable preferences** with the
envelope the 0.9.0 goal names — ``{revision, preferences:{…}}`` — and a *per-preference-key* rev, so a
phone that edits "notifications" and a desktop that edits "session types" both keep their edit even
when neither has seen the other's write. Entry-wise LWW over a *value's top-level names* cannot express
that, because the top-level names here ARE the preferences.

THE RULE THAT DECIDES EVERYTHING (goal §5 "Sync scope")
-------------------------------------------------------
A preference is either **portable** (the two clients should agree) or **device-local** (pushing one
client's value over the other's breaks it). The second class is refused **by name, with the reason**,
so "Gateway Settings" can never be silently synced: the desktop dials ``localhost:9119``, the phone
dials the tailnet address, and writing one over the other is how you lose a working desktop.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

VERSION = 1
MAX_BODY_BYTES = 64 * 1024
MAX_KEYS = 64
MAX_KEY_CHARS = 64
MAX_VALUE_BYTES = 8 * 1024
MAX_REV = 2 ** 53

#: Syncs. Each is a preference BOTH clients can honour without any device-specific knowledge.
PORTABLE_KEYS: frozenset[str] = frozenset({
    "session-types",     # which session types the list shows (0.8.0 D's two checkboxes)
    "notifications",     # the checkpoint switches (kinds + master), never the OS permission
    "display-order",     # roster/thread display + ordering preferences
})

#: NEVER syncs. Named individually so the 400 can say WHY, which is the whole point of splitting.
DEVICE_LOCAL_KEYS: dict[str, str] = {
    "base-url": "the gateway address each device dials is its own (localhost vs the tailnet)",
    "api-key": "a credential never leaves the device it was issued to",
    "surface": "which HTTP surface the address speaks is a property of the address",
    "routes": "the candidate route list is built from this device's own network",
    "pairing": "pairing state and device identity belong to the paired device",
    "device-id": "device identity belongs to the device",
    "device-label": "the label this device shows on the dashboard belongs to the device",
    "routes-preferred": "route preference is built from this device's own network",
    "push-token": "a push token is issued per install and is meaningless anywhere else",
    "notification-permission": "the OS permission is granted per device and cannot be granted remotely",
    "model": "the per-request model override is a device-local choice",
    "tailscale-package": "the tunnel app's package name is a property of this device's OS",
    "timeouts": "connect/probe budgets reflect this device's own network",
    "diagnostics": "the diagnostic history is a record of what THIS device did",
    "language": "language is kept local so a phone in one language cannot switch a desktop",
}

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class DocumentError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def empty_document() -> dict:
    """``{"version":1,"revision":0,"preferences":{},"revs":{},"updated_at":None}``."""
    return {"version": VERSION, "revision": 0, "preferences": {}, "revs": {}, "updated_at": None}


def public_view(doc: dict) -> dict:
    """What a client reads: ``{revision, preferences:{key:value}}`` (+ ``revs`` and the stamp).

    ``preferences`` is the plain key → value map the goal names, so a reader never has to know
    about revs to use the document. ``revs`` is exposed beside it because a *writer* needs the
    revision it last saw per key to make a correct patch.
    """
    return {
        "version": VERSION,
        "revision": int(doc.get("revision") or 0),
        "preferences": dict(doc.get("preferences") or {}),
        "revs": dict(doc.get("revs") or {}),
        "updated_at": doc.get("updated_at"),
    }


def _check_key(key: Any) -> str:
    if not isinstance(key, str) or not key:
        raise DocumentError(400, "preference keys must be non-empty strings")
    if len(key) > MAX_KEY_CHARS or not _KEY_RE.match(key):
        raise DocumentError(400, f"preference key '{key}' must be lower-case words joined by '-'")
    if key in DEVICE_LOCAL_KEYS:
        raise DocumentError(400, f"'{key}' is device-local and is never synced: {DEVICE_LOCAL_KEYS[key]}")
    if key not in PORTABLE_KEYS:
        raise DocumentError(
            400,
            f"unknown preference '{key}' (portable: {', '.join(sorted(PORTABLE_KEYS))})",
        )
    return key


def validate_patch(payload: Any) -> tuple[dict, dict, Optional[int]]:
    """Shape-check a POST body → ``(preferences, revs, seen_revision)`` or raise ``DocumentError(400)``.

    Accepted body: ``{"revision": <int the client last saw>, "preferences": {key: value, …},
    "revs": {key: <int>, …}}``. ``revs`` is optional: a writer that omits it is assumed to have seen
    the revision it declares. ``revision`` is optional: omitting it means "I have never read this
    document", which merges instead of clobbering.
    """
    if not isinstance(payload, dict):
        raise DocumentError(400, "body must be a JSON object")
    extra = set(payload) - {"revision", "preferences", "revs", "version"}
    if extra:
        raise DocumentError(400, f"unexpected field(s): {', '.join(sorted(extra))}")
    prefs = payload.get("preferences")
    if prefs is None:
        prefs = {}
    if not isinstance(prefs, dict):
        raise DocumentError(400, "'preferences' must be an object")
    if len(prefs) > MAX_KEYS:
        raise DocumentError(400, f"too many preferences in one patch ({len(prefs)} > {MAX_KEYS})")
    seen = payload.get("revision")
    if seen is not None:
        if isinstance(seen, bool) or not isinstance(seen, int) or seen < 0 or seen > MAX_REV:
            raise DocumentError(400, "'revision' must be a non-negative integer")
    raw_revs = payload.get("revs") or {}
    if not isinstance(raw_revs, dict):
        raise DocumentError(400, "'revs' must be an object")
    clean: dict[str, Any] = {}
    for key, value in prefs.items():
        _check_key(key)
        try:
            blob = json.dumps(value, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            raise DocumentError(400, f"preference '{key}' is not JSON-serialisable") from None
        if len(blob) > MAX_VALUE_BYTES:
            raise DocumentError(413, f"preference '{key}' exceeds {MAX_VALUE_BYTES} bytes")
        clean[key] = value
    clean_revs: dict[str, int] = {}
    for key, rev in raw_revs.items():
        _check_key(key)
        if isinstance(rev, bool) or not isinstance(rev, int) or rev < 0 or rev > MAX_REV:
            raise DocumentError(400, f"rev for '{key}' must be a non-negative integer")
        clean_revs[key] = rev
    return clean, clean_revs, seen


def merge(doc: dict, preferences: dict, revs: dict, seen: Optional[int], *, now: Optional[float] = None) -> dict:
    """Apply a validated patch to ``doc`` IN PLACE. Returns ``{applied, kept, bumped}``.

    Per-key last-write-wins **keyed on the revision the writer last saw**, which is the only clock
    that can tell a fresh edit from a stale one:

    * the writer's claim on a key is ``revs[key]`` when it sent one, else the document ``revision`` it
      declared as ``seen`` (``0`` = "I have never read this document");
    * a key is accepted when that claim is ``>=`` the revision the STORED value was written at, and
      the stored revision becomes the new (monotonic) document revision;
    * therefore an editor holding a stale ``revision`` is **kept, never a clobber**, while a device
      that has just read the document always wins — and two devices editing *different* keys both
      survive, because the claim is compared per key;
    * a tie keeps the stored value (the same no-churn rule the layout store uses).
    """
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))
    applied = kept = 0
    stored_revs: dict = doc.setdefault("revs", {})
    stored: dict = doc.setdefault("preferences", {})
    revision = int(doc.get("revision") or 0)
    for key, value in preferences.items():
        claim = revs.get(key)
        if claim is None:
            claim = int(seen or 0)
        claim = int(claim)
        if key in stored and claim < int(stored_revs.get(key) or 0):
            kept += 1
            continue
        revision += 1
        stored[key] = value
        stored_revs[key] = revision
        applied += 1
    # The document revision is monotonic and never goes backwards, even for a read-only patch.
    doc["revision"] = max(revision, int(seen or 0))
    if applied:
        doc["updated_at"] = stamp
    doc["version"] = VERSION
    return {"applied": applied, "kept": kept, "bumped": revision}


# ---- persistence (atomic, 0600, flock; same discipline as messenger's ui_state) -------------------


def state_dir() -> Path:
    override = os.environ.get("PERSONAE_STATE_DIR", "").strip()
    base = Path(override) if override else Path(__file__).resolve().parent.parent / "state"
    return base


_SAFE_PROFILE = re.compile(r"[^A-Za-z0-9._-]+")


def document_path(profile: str = "") -> Path:
    """One document per Hermes profile — a profile's preferences are that profile's."""
    name = _SAFE_PROFILE.sub("-", (profile or "").strip()) or "default"
    return state_dir() / f"preferences-{name}.json"


_thread_lock = threading.Lock()


@contextlib.contextmanager
def _locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(path.parent, 0o700)
    fd = os.open(path.with_name(path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        with _thread_lock:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _valid(raw: Any) -> dict:
    if not isinstance(raw, dict) or raw.get("version") != VERSION:
        raise ValueError("unexpected preferences document shape/version")
    if not isinstance(raw.get("preferences"), dict) or not isinstance(raw.get("revs"), dict):
        raise ValueError("malformed preferences document")
    for key in raw["preferences"]:
        if key not in PORTABLE_KEYS:
            raise ValueError(f"stored document carries a non-portable key {key!r}")
    return raw


def _write(path: Path, doc: dict) -> None:
    blob = json.dumps(doc, separators=(",", ":"), sort_keys=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def load(profile: str = "") -> dict:
    """Missing → an empty document (not an error). Corrupt → quarantined, empty, loud log."""
    import logging

    path = document_path(profile)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_document()
    except (ValueError, TypeError):
        raw = None
    if raw is None:
        bad = path.with_name(f"{path.name}.bad-{time.strftime('%Y%m%dT%H%M%S')}")
        with contextlib.suppress(OSError):
            os.replace(path, bad)
        logging.getLogger("personae.state").error(
            "personae-mobile-state: %s was unreadable; backed up to %s and starting EMPTY", path.name, bad.name)
        return empty_document()
    try:
        return _valid(raw)
    except ValueError as exc:
        logging.getLogger("personae.state").error("personae-mobile-state: %s: %s", path.name, exc)
        return empty_document()


def apply_patch(payload: Any, profile: str = "", *, now: Optional[float] = None) -> dict:
    """Validate → merge under the lock → persist atomically. Returns the merged public view."""
    preferences, revs, seen = validate_patch(payload)
    path = document_path(profile)
    with _locked(path):
        doc = load(profile)
        counters = merge(doc, preferences, revs, seen, now=now)
        _write(path, doc)
    return {**public_view(doc), **counters}
