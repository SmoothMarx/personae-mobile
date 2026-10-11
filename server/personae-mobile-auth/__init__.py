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

The credential is env-only (``HERMES_PERSONAE_BEARER``); nothing is read from
``config.yaml`` and no secret is ever logged (the audit layer strips token-like fields).
Registration is skipped — fail-closed, no route opened — when the var is unset or fails
the entropy gate.
"""
from __future__ import annotations

import hmac
import logging
import math
import os
import time
from collections import Counter
from typing import Optional

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, ProviderError, RefreshExpiredError, Session, TokenPrincipal)
from hermes_cli.dashboard_auth.audit import AuditEvent, audit_log

logger = logging.getLogger(__name__)
_TAG = "dashboard-auth-personae-mobile"

ENV_VAR = "HERMES_PERSONAE_BEARER"

# Fail-closed entropy bar, identical to the bundled drain provider: >=256-bit secret,
# enough distinct characters to reject degenerate values, distribution-aware guard.
_DEFAULT_MIN_SECRET_CHARS = 43
_MIN_DISTINCT_CHARS = 16
_MIN_SHANNON_BITS = 128.0

#: Non-interactive principal identity. Stable, non-secret, used for audit lines.
PRINCIPAL = "personae-mobile"

LAST_SKIP_REASON: str = ""


class SkipRegistration(Exception):
    """Raised by the settings resolver to decline registration; ``reason`` is operator-facing."""

    def __init__(self, reason: str, level: str = "debug") -> None:
        super().__init__(reason)
        self.reason = reason
        self.level = level


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


class PersonaeMobileProvider(DashboardAuthProvider):
    """Non-interactive shared-bearer provider for the Personae Mobile app."""

    name = "personae-mobile"
    display_name = "Personae Mobile (app credential)"
    supports_token = True
    supports_session = True
    supports_password = False
    _NOT_INTERACTIVE = ("Personae Mobile uses a non-interactive service credential "
                       "(HERMES_PERSONAE_BEARER); it has no interactive login flow.")
    _NO_START_LOGIN = ("Personae Mobile is a non-interactive service credential; sign in on "
                       "this dashboard with your normal account instead.")

    def __init__(self, *, secret: str) -> None:
        # Defence in depth: construction enforces the entropy bar too, so a caller
        # bypassing register() still cannot build a weak provider.
        reason = assess_secret_strength(secret)
        if reason is not None:
            raise ValueError(f"personae-mobile bearer rejected: {reason}")
        self._secret = secret

    # ---- non-interactive capability 1: token seam (verify_token) -------------

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        """Constant-time compare; ``personae-mobile`` principal on match, else ``None`` so the
        generic seam fails closed / falls through to the next provider."""
        if token and hmac.compare_digest(token.encode("utf-8"), self._secret.encode("utf-8")):
            audit_log(AuditEvent.TOKEN_AUTH_SUCCESS, provider=self.name, principal=PRINCIPAL)
            return TokenPrincipal(principal=PRINCIPAL, provider=self.name,
                                  scopes=("personae-mobile",))
        return None

    # ---- non-interactive capability 2: bearer-as-session (verify_session) ----

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        """Accept the same bearer as a *synthetic* session, which is how the gate serves a
        token-mode remote client without a cookie (see the module docstring). Never raises and
        never returns a Session for a foreign token, so it stacks harmlessly in front of the
        cookie providers (basic). No cookie is ever minted from this identity: the gate's bearer
        arm attaches ``request.state.session`` for the single request only."""
        if not access_token or not hmac.compare_digest(
                access_token.encode("utf-8"), self._secret.encode("utf-8")):
            return None
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
    """Resolve kwargs from env; raise ``SkipRegistration`` (fail closed) when unusable."""
    secret = os.environ.get(ENV_VAR, "").strip()
    if not secret:
        raise SkipRegistration(
            f"{ENV_VAR} is not set. Set a >=256-bit value (e.g. `openssl rand -hex 32`) to let the "
            "Personae Mobile app authenticate; leave it unset to disable the app credential.")
    reason = assess_secret_strength(secret)
    if reason is not None:
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
TOKEN_ROUTE_PATHS: tuple[str, ...] = ("/api/profiles/sessions/sidebar",)


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
    """Register the provider (fail-closed when the env var is missing/weak) and opt the app-only
    paths into the exact-path token seam.

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
        "%s: registered non-interactive app credential provider (%s); token routes=%s",
        _TAG, provider.name, registered or "[]")
