"""Personae Mobile — the state surface (REST half of ``personae-mobile-state``, 0.9.0 Phase A).

Mounted by the dashboard at ``/api/plugins/personae-mobile-state/``.

WHY THIS FILE EXISTS
--------------------
Two things the phone needs are neither on the gateway's JSON-RPC surface nor safe to re-implement:

1. **archive / delete, on the verbs the dashboard already uses.** The phone's roster can already
   archive and delete *on the dashboard surface*; the per-session flags route and the per-session
   delete route are the verbs, and both live in core (``hermes_cli/web_routers/sessions.py``). So this
   backend does **not** touch the database: it calls *those very endpoint functions* in-process, which
   means every guard they carry — profile scoping, the ``409`` for an active write guard, the
   idempotent "already absent is a success" delete, the corrupt-store ``503`` — applies here for free
   and can never drift from the dashboard's behaviour.

   The one rule this file ADDS is the one the goal names: **a pinned session is not archivable**
   (mirroring ``archive_stale_sessions(..., exclude_pinned=True)``), and it says so with a
   machine-readable reason instead of failing silently. ``hidden`` is deliberately NOT collapsed into
   ``archived``: they are different flags with different owners, and only ``archived`` is touched here.

2. **the per-user preference document** — ``GET/POST /preferences`` over ``preferences.py``, the
   portable/device-local split the 0.9.0 goal's §5 describes. Portable keys sync; device-local keys are
   refused BY NAME WITH THE REASON.

WHY A NEW PLUGIN AND NOT AN EDIT TO AN EXISTING ONE
---------------------------------------------------
``hermes update`` overwrites ``~/.hermes/hermes-agent``. This file is deployed to
``~/.hermes/plugins/personae-mobile-state/`` — user data, which an update does not touch — and it
edits nothing in the install tree. See ``SERVER-PATCH.md`` for the one-line additive edit that IS made
(in the messenger plugin's key table) and the exact command to reapply everything.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

router = APIRouter()

PLUGIN = "personae-mobile-state"


def _preferences():
    """``preferences.py`` beside this file (this module is loaded by path, so no package import)."""
    name = "personae_state_preferences"
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / "preferences.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


@router.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness probe: proves the dashboard mounted this plugin's api.py."""
    return {"ok": True, "plugin": PLUGIN, "verbs": ["archive", "delete"], "preferences": True}


# ───────────────────────────────────────────────────────────── verbs ──


def _sessions_router():
    """The dashboard's own session endpoints and models — imported lazily, from core, never copied."""
    from hermes_cli.web_models import SessionRename
    from hermes_cli.web_routers.sessions import (
        _resolve_session_id,
        _with_db,
        delete_session_endpoint,
        rename_session_endpoint,
    )

    return SessionRename, _resolve_session_id, _with_db, delete_session_endpoint, rename_session_endpoint


async def _pinned(session_id: str, profile: str) -> Optional[bool]:
    """``True``/``False`` for a session that exists, ``None`` when it does not (or the store is unreadable).

    A read of one column through the dashboard's own profile-scoped DB opener: no second connection
    policy, no second store.
    """
    import asyncio

    _, _resolve_session_id, _with_db, _, _ = _sessions_router()

    def _read(db):
        sid = _resolve_session_id(db, session_id)
        row = db.get_session(sid) if sid else None
        return None if row is None else bool(row.get("pinned"))

    try:
        return await asyncio.to_thread(_with_db, profile or None, _read, read_only=True)
    except Exception:  # noqa: BLE001 — an unreadable store is reported by the verb itself
        return None


@router.post("/sessions/{session_id}/archive")
async def archive_session(session_id: str, request: Request, profile: str = Query("")) -> JSONResponse:
    """Archive ONE session, through the dashboard's own flags verb.

    Refuses a pinned session with ``409 {"error": "pinned"}`` — the goal's ``exclude_pinned=True`` rule,
    surfaced instead of swallowed. Idempotent: archiving an archived session is a success.
    """
    SessionRename, _, _, _, rename_session_endpoint = _sessions_router()
    if (await _pinned(session_id, profile)) is True:
        # The OpenAI-shaped envelope the app's own error ladder already reads (`httpError` in
        # src/api/errors.ts): `error.code` becomes `ApiError.code`, so the phone can tell a refusal
        # apart from a failure instead of string-matching a sentence.
        return JSONResponse(
            {
                "ok": False,
                "error": {
                    "message": "A pinned session is not archivable. Unpin it first.",
                    "type": "session_flag_error",
                    "code": "pinned",
                },
                "detail": "A pinned session is not archivable. Unpin it first.",
                "session_id": session_id,
            },
            status_code=409,
        )
    result = await rename_session_endpoint(session_id, SessionRename(archived=True, profile=profile or None))
    body = dict(result or {})
    body.update({"ok": True, "action": "archive", "session_id": session_id})
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.post("/sessions/{session_id}/delete")
async def delete_session(session_id: str, request: Request, profile: str = Query("")) -> JSONResponse:
    """Delete ONE session, through the dashboard's own delete verb — the only irreversible one.

    The dashboard's verb is already idempotent (an already-absent session is ``{"ok": true,
    "already_absent": true}``) and already scoped, and it refuses to delete a session with an active
    write guard (``409``). None of that is re-implemented here.
    """
    _, _, _, delete_session_endpoint, _ = _sessions_router()
    result = await delete_session_endpoint(session_id, profile or None)
    body = dict(result or {})
    body.update({"ok": True, "action": "delete", "session_id": session_id})
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


# ─────────────────────────────────────────────────────── preferences ──


@router.get("/preferences")
async def get_preferences(profile: str = Query("")) -> JSONResponse:
    """The document: ``{revision, preferences:{key:value}, revs:{key:n}}``. Missing → revision 0, empty."""
    prefs = _preferences()
    return JSONResponse(
        prefs.public_view(prefs.load(profile)),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/preferences/keys")
async def preference_keys() -> Dict[str, Any]:
    """What syncs and what never does — the split, published so a client can never guess at it.

    This is the machine-readable half of the Settings page's portable/device-local disclosure.
    """
    prefs = _preferences()
    return {
        "portable": sorted(prefs.PORTABLE_KEYS),
        "device_local": dict(sorted(prefs.DEVICE_LOCAL_KEYS.items())),
        "max_body_bytes": prefs.MAX_BODY_BYTES,
    }


@router.post("/preferences")
async def put_preferences(request: Request, profile: str = Query("")) -> JSONResponse:
    """Merge a patch: per-key last-write-wins, portable keys only, a stale ``revision`` never clobbers."""
    prefs = _preferences()
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > prefs.MAX_BODY_BYTES:
        return JSONResponse(
            {"error": "too_large", "detail": f"body exceeds {prefs.MAX_BODY_BYTES} bytes"}, status_code=413)
    raw = await request.body()
    if len(raw) > prefs.MAX_BODY_BYTES:
        return JSONResponse(
            {"error": "too_large", "detail": f"body exceeds {prefs.MAX_BODY_BYTES} bytes"}, status_code=413)
    try:
        payload = json.loads(raw.decode("utf-8") or "null")
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "bad_request", "detail": "body is not valid JSON"}, status_code=400)
    try:
        merged = prefs.apply_patch(payload, profile)
    except prefs.DocumentError as exc:
        # OpenAI-shaped envelope (`{"error": {"message", "type", "code"}}`) — the shape the app's own
        # `httpError` ladder reads, so the refusal's SENTENCE reaches the user and its CODE reaches the
        # logic. A bare `{"error": "bad_request"}` would flatten both to one useless word.
        code = "too_large" if exc.status == 413 else "bad_request"
        return JSONResponse(
            {"error": {"message": exc.detail, "type": "preference_error", "code": code}, "detail": exc.detail},
            status_code=exc.status,
        )
    return JSONResponse(merged, headers={"Cache-Control": "no-store"})
