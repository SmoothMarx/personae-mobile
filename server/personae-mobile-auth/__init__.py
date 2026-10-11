"""PersonaeMobileProvider — dashboard auth for the Personae Mobile app.

A non-interactive shared-bearer credential, modelled on the bundled
``plugins/dashboard_auth/drain/`` provider (constant-time compare, fail-closed >=256-bit
entropy gate, audit line) but implementing BOTH non-interactive capabilities the
``DashboardAuthProvider`` ABC documents:

* ``verify_token`` + the ``register_token_route`` seam — the service-credential shape
  (``token_principal`` + ``token_authenticated`` on a registered exact path);
* ``verify_session`` — the *token-mode remote client* shape
  (``dashboard_auth/middleware.py``: a presented ``Authorization: Bearer`` is run through
  ``verify_session`` across session providers, the verified Session is attached to
  ``request.state.session`` and the request is served without a cookie). This is the same
  leg the Desktop app's token-mode connection uses, and it is what makes
  ``POST /api/auth/ws-ticket`` reachable: that route calls ``_require_session``
  (``dashboard_auth/routes.py``), which reads ``request.state.session`` — a
  token-route-only registration answers 401 there, because the token seam sets
  ``token_authenticated`` only.

Credentials (0.6.0)
-------------------
1. the **env bearer** ``HERMES_PERSONAE_BEARER`` — the legacy/static credential, unchanged
   (constant-time compare, >=256-bit fail-closed entropy gate, same audit lines);
2. **per-device tokens** minted by browser-mediated pairing (``dashboard/plugin_api.py``): only
   ``sha256(token)`` is stored (``store.py`` -> ``state/credentials.json``, 0600), revocable, with
   ``last_seen_at``. Accepted by ``verify_token`` and ``verify_session`` exactly like the bearer;
3. a **pending pairing code** — accepted by ``verify_token`` ONLY while the token seam is
   authenticating ``POST /api/plugins/personae-mobile-auth/pair/redeem`` (see
   :func:`_calling_request`), never by ``verify_session``, never on any other path.

Nothing is read from ``config.yaml`` and no secret is ever logged (the audit layer strips token-like
fields; this module never passes one). Registration is skipped — fail-closed, no route opened —
when there is neither a usable env bearer nor a paired device (same ``SkipRegistration`` path and
reason string as 0.5.0).
"""
from __future__ import annotations

import hmac
import importlib.util
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, ProviderError, RefreshExpiredError, Session, TokenPrincipal)
from hermes_cli.dashboard_auth.audit import AuditEvent, audit_log

logger = logging.getLogger(__name__)
_TAG = "dashboard-auth-personae-mobile"

ENV_VAR = "HERMES_PERSONAE_BEARER"

#: Non-interactive principal identity. Stable, non-secret, used for audit lines.
PRINCIPAL = "personae-mobile"

LAST_SKIP_REASON: str = ""


class SkipRegistration(Exception):
    """Raised by the settings resolver to decline registration; ``reason`` is operator-facing."""

    def __init__(self, reason: str, level: str = "debug") -> None:
        super().__init__(reason)
        self.reason = reason
        self.level = level


def _store():
    """The shared credential store module (one object for the provider AND the REST routes)."""
    name = "personae_mobile_auth_store"
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / "store.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


# The entropy gate lives in store.py (one bar for the env bearer AND minted device tokens); these
# names stay importable from this module exactly as in 0.5.0.
_DEFAULT_MIN_SECRET_CHARS = _store()._DEFAULT_MIN_SECRET_CHARS
_MIN_DISTINCT_CHARS = _store()._MIN_DISTINCT_CHARS
_MIN_SHANNON_BITS = _store()._MIN_SHANNON_BITS
_shannon_bits = _store()._shannon_bits
assess_secret_strength = _store().assess_secret_strength


#: The one path on which a pairing code is a credential.
REDEEM_PATH = "/api/plugins/personae-mobile-auth/pair/redeem"
#: Scopes the redeem handler reads off ``request.state.token_principal``.
SCOPE_PAIR = "personae-pair"
SCOPE_PAIR_RATE_LIMITED = "personae-pair-ratelimited"
PAIRING_PRINCIPAL = "personae-pairing"


def _calling_request():
    """The Starlette ``Request`` the token seam is authenticating, or ``None``.

    ``DashboardAuthProvider.verify_token(token=...)`` receives no request, yet a pairing code must be
    honoured on ONE path only — otherwise it would also open the other registered token route
    (``/api/profiles/sessions/sidebar``) for its 5-minute life. The seam's caller is
    ``token_auth.authenticate_token(request)``; we read that frame's ``request`` local. This is
    deliberately FAIL-CLOSED: if core ever changes shape and no request can be found, pairing codes
    are simply not accepted (redeem answers 401) — nothing widens.
    """
    try:
        from starlette.requests import Request
    except Exception:  # pragma: no cover
        return None
    frame = sys._getframe(1)
    for _ in range(8):
        if frame is None:
            return None
        candidate = frame.f_locals.get("request")
        if isinstance(candidate, Request):
            return candidate
        frame = frame.f_back
    return None


def _client_ip(request) -> str:
    try:
        from hermes_cli.dashboard_auth.request_utils import client_ip
        return client_ip(request)
    except Exception:  # pragma: no cover
        return request.client.host if getattr(request, "client", None) else ""


class PersonaeMobileProvider(DashboardAuthProvider):
    """Non-interactive provider for the Personae Mobile app: env bearer + paired devices."""

    name = "personae-mobile"
    display_name = "Personae Mobile (app credential)"
    supports_token = True
    supports_session = True
    supports_password = False
    _NOT_INTERACTIVE = ("Personae Mobile uses a non-interactive service credential "
                       "(HERMES_PERSONAE_BEARER or a paired device); it has no interactive login flow.")
    _NO_START_LOGIN = ("Personae Mobile is a non-interactive service credential; sign in on "
                       "this dashboard with your normal account instead.")

    def __init__(self, *, secret: Optional[str]) -> None:
        # Defence in depth: construction enforces the entropy bar too, so a caller
        # bypassing register() still cannot build a weak provider. ``secret=None`` means "no env
        # bearer" (devices only) — never "accept anything".
        if secret is not None:
            reason = assess_secret_strength(secret)
            if reason is not None:
                raise ValueError(f"personae-mobile bearer rejected: {reason}")
        self._secret = secret

    def _is_env_bearer(self, token: str) -> bool:
        return bool(token) and self._secret is not None and hmac.compare_digest(
            token.encode("utf-8"), self._secret.encode("utf-8"))

    @staticmethod
    def _device_for(token: str) -> Optional[dict]:
        try:
            return _store().find_device(token)
        except Exception as exc:  # noqa: BLE001 — a broken store fails closed, never 500s
            logger.warning("%s: device lookup failed: %s", _TAG, type(exc).__name__)
            return None

    # ---- non-interactive capability 1: token seam (verify_token) -------------

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        """(a) env bearer, (b) a non-revoked device token, (c) a pairing code — (c) only while the
        seam is authenticating ``POST`` :data:`REDEEM_PATH`. ``None`` otherwise, so the generic seam
        fails closed / falls through to the next provider."""
        if not token:
            return None
        if self._is_env_bearer(token):
            audit_log(AuditEvent.TOKEN_AUTH_SUCCESS, provider=self.name, principal=PRINCIPAL)
            return TokenPrincipal(principal=PRINCIPAL, provider=self.name,
                                  scopes=("personae-mobile",))
        request = _calling_request()
        on_redeem = (request is not None and request.url.path == REDEEM_PATH
                     and request.method.upper() == "POST")
        if on_redeem:
            # Every guess on the redeem path counts, valid or not, so the code space cannot be
            # sprayed; the handler turns this principal into a clean 429.
            if _store().rate_limited(_client_ip(request)):
                audit_log(AuditEvent.TOKEN_AUTH_FAILURE, provider=self.name, reason="pair_rate_limited",
                          path=REDEEM_PATH, ip=_client_ip(request))
                return TokenPrincipal(principal=PAIRING_PRINCIPAL, provider=self.name,
                                      scopes=(SCOPE_PAIR_RATE_LIMITED,))
        device = self._device_for(token)
        if device is not None:
            _store().touch(device["id"])
            audit_log(AuditEvent.TOKEN_AUTH_SUCCESS, provider=self.name,
                      principal=f"{PRINCIPAL}:{device['id']}")
            return TokenPrincipal(principal=f"{PRINCIPAL}:{device['id']}", provider=self.name,
                                  scopes=("personae-mobile",))
        if on_redeem:
            try:
                state = _store().classify_code(token)
            except Exception:  # noqa: BLE001
                state = None
            if state is not None:
                # Known code (pending, redeemed or expired): let the handler answer 200/410. An
                # unknown code falls through to the seam's 401.
                return TokenPrincipal(principal=PAIRING_PRINCIPAL, provider=self.name,
                                      scopes=(SCOPE_PAIR,))
        return None

    # ---- non-interactive capability 2: bearer-as-session (verify_session) ----

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        """Accept the env bearer or a device token as a *synthetic* session, which is how the gate
        serves a token-mode remote client without a cookie (see the module docstring). Never
        raises and never returns a Session for a foreign token (or a pairing code), so it stacks
        harmlessly in front of the cookie providers (basic). No cookie is ever minted from this
        identity: the gate's bearer arm attaches ``request.state.session`` for one request only."""
        if not access_token:
            return None
        if self._is_env_bearer(access_token):
            audit_log(AuditEvent.LOGIN_SUCCESS, provider=self.name, user_id=PRINCIPAL,
                      reason="bearer_session")
            return Session(
                user_id=PRINCIPAL,
                email="",
                display_name="Personae Mobile (app credential)",
                org_id="",
                provider=self.name,
                expires_at=int(time.time()) + 86400,
                access_token=access_token,
                refresh_token="",
            )
        device = self._device_for(access_token)
        if device is None:
            return None
        _store().touch(device["id"])
        audit_log(AuditEvent.LOGIN_SUCCESS, provider=self.name, user_id=f"{PRINCIPAL}:{device['id']}",
                  reason="device_session")
        return Session(
            user_id=f"{PRINCIPAL}:{device['id']}",
            email="",
            display_name=str(device.get("label") or "Personae Mobile"),
            org_id="",
            provider=self.name,
            expires_at=int(time.time()) + 86400,
            access_token=access_token,
            refresh_token="",
        )

    # ---- interactive methods: unsupported (service credential only) ----------

    def start_login(self, *, redirect_uri: str):
        # Clean 503 ("Provider unreachable: ...") rather than a 500 if anyone presses the inert
        # entry the login page renders for a session-capable provider.
        raise ProviderError(self._NO_START_LOGIN)

    def complete_login(self, *, code: str, state: str, code_verifier: str, redirect_uri: str):
        raise ProviderError(self._NOT_INTERACTIVE)

    def refresh_session(self, *, refresh_token: str) -> Session:
        # A foreign refresh token is simply not ours: RefreshExpiredError rejects this candidate
        # only, so a basic-auth cookie session keeps refreshing through its own provider (a
        # ProviderError here would 503 every browser refresh).
        raise RefreshExpiredError(
            "PersonaeMobileProvider holds no refreshable session (non-interactive credential).")

    def revoke_session(self, *, refresh_token: str) -> None:
        return None


# ---- Plugin entry point ------------------------------------------------------

def _settings() -> dict:
    """Resolve kwargs from env; raise ``SkipRegistration`` (fail closed) when unusable.

    0.6.0: a paired device keeps the provider alive even without an env bearer; with neither, the
    skip (path, reason string, level) is exactly 0.5.0's."""
    secret = os.environ.get(ENV_VAR, "").strip()
    try:
        devices = _store().has_active_devices()
    except Exception:  # noqa: BLE001 — a broken store reads as "no devices" (fail closed)
        devices = False
    if not secret:
        if devices:
            return {"secret": None}
        raise SkipRegistration(
            f"{ENV_VAR} is not set. Set a >=256-bit value (e.g. `openssl rand -hex 32`) to let the "
            "Personae Mobile app authenticate; leave it unset to disable the app credential.")
    reason = assess_secret_strength(secret)
    if reason is not None:
        if devices:
            logger.warning("%s: %s rejected - %s. The env bearer stays disabled; paired devices "
                           "still authenticate.", _TAG, ENV_VAR, reason)
            return {"secret": None}
        raise SkipRegistration(
            f"{ENV_VAR} rejected - {reason}. The app credential stays disabled (fail-closed).",
            level="warning")
    return {"secret": secret}


#: The smallest set of paths the Personae Mobile app calls that are NOT also called by the
#: dashboard SPA itself (measured: `grep -rl 'profiles/sessions/sidebar'
#: hermes_cli/web_dist` finds nothing, while `/api/profiles` and `POST /api/auth/ws-ticket` are
#: both in the bundle). Registering a path hands it to the bearer-only seam, which answers 401
#: to a request with no bearer *even when it carries a valid browser cookie session*
#: (token_auth.py returns before the cookie gate is reached) — so registering an SPA path would
#: take that route away from the user's browser. Every other route the app needs is served by the
#: bearer-as-session seam instead, which narrows nothing for the browser.
#:
#: 0.6.0 adds :data:`REDEEM_PATH`: the phone has no cookie, and the browser never calls it (the
#: /pair page only MINTS codes), so the bearer-only seam takes nothing away from anyone there.
TOKEN_ROUTE_PATHS: tuple[str, ...] = ("/api/profiles/sessions/sidebar", REDEEM_PATH)


def _register_token_routes() -> list[str]:
    """Opt the app-only paths into the exact-path token seam; returns what was registered.

    ``register_token_route`` is exact-path set membership (no prefix/glob support), so this stays
    a literal list. A failure here must never break plugin load: the bearer-as-session seam still
    serves every route the app uses.
    """
    from hermes_cli.dashboard_auth.token_auth import is_token_route, register_token_route

    registered: list[str] = []
    for path in TOKEN_ROUTE_PATHS:
        try:
            register_token_route(path)
        except Exception as exc:  # noqa: BLE001 — never fatal for an auth provider
            logger.warning("%s: could not register token route %s: %s", _TAG, path, exc)
            continue
        if is_token_route(path):
            registered.append(path)
    return registered


def register(ctx) -> None:
    """Register the provider (fail-closed when there is neither a usable env bearer nor a paired
    device) and opt the app-only paths into the exact-path token seam.

    The bearer-as-session capability (``verify_session``) is what carries the app: it is honoured
    on every route by the gate, so the app reaches ``/api/profiles``, ``/api/sessions*`` and
    ``POST /api/auth/ws-ticket`` (which needs ``request.state.session`` — a token-route-only
    registration answers 401 there) without any of those paths being taken away from the browser.
    ``TOKEN_ROUTE_PATHS`` therefore holds only paths the SPA never calls.
    """
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""
    try:
        kwargs = _settings()
        provider = PersonaeMobileProvider(**kwargs)
    except SkipRegistration as skip:
        LAST_SKIP_REASON = skip.reason
        getattr(logger, skip.level)("%s: %s", _TAG, skip.reason)
        return
    except ValueError as exc:
        LAST_SKIP_REASON = f"PersonaeMobileProvider construction failed: {exc}"
        logger.warning("%s: %s", _TAG, LAST_SKIP_REASON)
        return
    ctx.register_dashboard_auth_provider(provider)
    registered = _register_token_routes()
    logger.info(
        "%s: registered non-interactive app credential provider (%s; env bearer=%s); token routes=%s",
        _TAG, provider.name, "on" if kwargs.get("secret") else "off", registered or "[]")
