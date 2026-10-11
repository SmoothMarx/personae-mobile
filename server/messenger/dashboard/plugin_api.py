"""Read-only message-body search for the Messenger desktop pane.

Why this file exists
--------------------
The pane reaches the host through exactly two doors, and neither can read a
message body:

* **gateway JSON-RPC** — session *metadata* only. There is no search method, and
  the app's own search helper (``apps/desktop/src/lib/session-search.ts``)
  matches the titles and previews the client already holds.
* **``ctx.rest``** — namespaced to ``/api/plugins/<id>/``, i.e. this file.

Message text lives in each profile's ``state.db`` behind FTS. The core route
``GET /api/sessions/search`` reads it, but it is not part of the SDK surface, so
the pane publishes that single read on its own namespace instead.

Contract
--------
Read-only and narrow by design: the store is opened with ``read_only=True``,
only ``search_messages`` is called, and the response carries session id, role,
snippet, timestamp, source and model — no tool output, no context blobs. An
empty ``q`` returns nothing rather than the whole table, and a broken store
returns an error object instead of a 500.

Shared UI state (0.2.0 — Personae Mobile 0.6.0)
-----------------------------------------------
``GET/PUT /state`` is the one WRITE this backend has: the pane's *shared* layout
prefs (sort, manual order, sections, per-profile groups, colours, hidden,
Apropos) so the desktop pane and the phone show the same roster. Entry-wise
last-writer-wins by ``rev`` with tombstones; device-local keys are refused by
name; bodies over 256 KB are 413. Storage: ``state/ui-state.json`` (0600,
atomic, flock). The logic lives in ``ui_state.py`` (see its docstring).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

router = APIRouter()


def _ui_state():
    """``ui_state.py`` beside this file (this module is loaded by path, so no package import)."""
    name = "messenger_ui_state"
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / "ui_state.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod

#: Columns the pane renders. Deliberately excludes tool payloads and context.
_FIELDS = ("session_id", "role", "snippet", "timestamp", "source", "model")


@router.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness probe: proves the dashboard mounted this plugin's api.py."""
    return {"ok": True, "plugin": "messenger", "readOnly": False, "state": True}


@router.get("/state")
async def get_state() -> JSONResponse:
    """The merged shared UI state. A missing store is an empty one, never an error."""
    st = _ui_state()
    return JSONResponse(st.view(st.load()), headers={"Cache-Control": "no-store"})


@router.put("/state")
async def put_state(request: Request) -> JSONResponse:
    """Merge shared keys (entry-wise LWW by rev, tombstones) and return the merged view."""
    st = _ui_state()
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > st.MAX_BODY_BYTES:
        return JSONResponse({"error": "too_large", "detail": f"body exceeds {st.MAX_BODY_BYTES} bytes"},
                            status_code=413)
    raw = await request.body()
    if len(raw) > st.MAX_BODY_BYTES:
        return JSONResponse({"error": "too_large", "detail": f"body exceeds {st.MAX_BODY_BYTES} bytes"},
                            status_code=413)
    try:
        payload = json.loads(raw.decode("utf-8") or "null")
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "bad_request", "detail": "body is not valid JSON"}, status_code=400)
    try:
        merged = st.apply_put(payload)
    except st.StateError as exc:
        return JSONResponse({"error": "too_large" if exc.status == 413 else "bad_request",
                             "detail": exc.detail}, status_code=exc.status)
    return JSONResponse(merged, headers={"Cache-Control": "no-store"})


def _denied_sources() -> set:
    """The same machine-run deny-list every human-facing listing uses.

    Read from core rather than copied, so this pane drifts with the backend instead of
    against it. ``hermes_state_sessions`` is a sibling of this process, not a dependency
    of the SDK — hence the import guard.
    """
    try:
        from hermes_state_sessions import INTERNAL_LISTING_SOURCES

        return {str(s).strip().lower() for s in INTERNAL_LISTING_SOURCES}
    except Exception:
        return {"cron", "kanban", "tool", "oneshot", "webhook"}


def _store(profile: str):
    """Open ``profile``'s session store read-only, or raise for the caller to catch."""
    from hermes_cli.web_server_sessions import (
        _open_session_db_at_path,
        _session_db_path_for_profile,
    )

    path = _session_db_path_for_profile(profile or None)
    if not path.exists():
        return None
    return _open_session_db_at_path(path, read_only=True)


@router.get("/archived")
async def archived(
    profile: str = "",
    limit: int = Query(60, ge=1, le=200),
) -> Dict[str, Any]:
    """Archived sessions for one profile — the one listing the RPC cannot serve.

    ``session.list`` whitelists ``title`` / ``limit`` / ``include_hidden``, so it can only
    ever return live rows; the archive is one read away in the same store, and the pane
    publishes that read on its own namespace. Read-only, narrow columns, same deny-list as
    every other human-facing listing (machine runs are not conversations).
    """
    db = None
    try:
        db = _store(profile)
    except Exception as exc:  # unknown profile, unreadable store, ...
        return {"error": f"{type(exc).__name__}: {exc}", "profile": profile, "sessions": []}
    if db is None:
        return {"profile": profile, "count": 0, "sessions": []}

    try:
        # Over-fetch, then trim after the deny-list so a machine-run-heavy archive still
        # fills the page.
        rows: List[Dict[str, Any]] = db.list_sessions_rich(
            source=None,
            limit=max(limit * 2, 200),
            order_by_last_active=True,
            compact_rows=True,
            include_archived=True,
            archived_only=True,
        )
    except Exception as exc:  # noqa: BLE001 - a broken store must not 500 the pane
        return {"error": f"{type(exc).__name__}: {exc}", "profile": profile, "sessions": []}
    finally:
        try:
            db.close()
        except Exception:
            pass

    denied = _denied_sources()
    out: List[Dict[str, Any]] = []
    for row in rows or []:
        if (row.get("source") or "").strip().lower() in denied:
            continue
        out.append(
            {
                "id": row.get("id"),
                "title": row.get("title") or row.get("display_name") or "",
                "source": row.get("source") or "",
                "last_active": row.get("last_active") or row.get("last_activity_at"),
                "started_at": row.get("started_at"),
                "message_count": row.get("message_count"),
                "preview": row.get("preview") or "",
                "archived": True,
            }
        )
        if len(out) >= limit:
            break

    return {"profile": profile, "count": len(out), "sessions": out}


@router.get("/search")
async def search(
    q: str = "",
    profile: str = "",
    limit: int = Query(40, ge=1, le=100),
) -> Dict[str, Any]:
    """Full-text message search inside one profile's own session store."""
    needle = (q or "").strip()
    if not needle:
        return {"profile": profile, "query": "", "results": []}

    db = None
    try:
        db = _store(profile)
    except Exception as exc:  # unknown profile, unreadable store, ...
        return {
            "error": f"{type(exc).__name__}: {exc}",
            "profile": profile,
            "results": [],
        }
    if db is None:
        return {"profile": profile, "query": needle, "results": []}

    try:
        rows: List[Dict[str, Any]] = db.search_messages(needle, limit=limit, fields=_FIELDS)
    except Exception as exc:  # noqa: BLE001 - a broken store must not 500 the pane
        return {"error": f"{type(exc).__name__}: {exc}", "profile": profile, "results": []}
    finally:
        try:
            db.close()
        except Exception:
            pass

    return {
        "profile": profile,
        "query": needle,
        "results": [
            {
                "session_id": row.get("session_id"),
                "role": row.get("role"),
                "snippet": row.get("snippet") or "",
                "timestamp": row.get("timestamp"),
                "source": row.get("source"),
                "model": row.get("model"),
            }
            for row in rows or []
        ],
    }
