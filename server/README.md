# server/ — the dashboard-side setup the app depends on

The Personae Mobile app talks to the **gated dashboard** on `0.0.0.0:9119`
(`hermes-serve.service`), not to the `:9222` api_server. A dashboard bound to a
non-loopback address is gated by design and accepts only a verified session, so the phone
needs a credential that is not a browser cookie. That credential is this plugin:
a **user-level dashboard auth provider** registering through the sanctioned
`PluginContext.register_dashboard_auth_provider` seam.

## What the provider is

| | |
|---|---|
| name | `personae-mobile` |
| secret | `HERMES_PERSONAE_BEARER`, env-only, >=256-bit (`openssl rand -hex 32`), fail-closed entropy gate |
| token capability | `verify_token` (constant-time compare, principal `personae-mobile`) |
| session capability | `verify_session` — the documented *token-mode remote client* bearer leg: `Authorization: Bearer <secret>` on any dashboard route is run through the session providers and its Session is attached to `request.state.session` |
| password login | none (`supports_password = False`) |
| audit | `dashboard_auth/audit.py` lines on success/failure; the secret is never logged |

`hermes-serve.service` is a **user** unit whose `EnvironmentFile` is already
`~/.hermes/.env` (mode 600), which is where the live dashboard's own basic-auth variables live.
The bearer belongs there too — same mechanism, no drop-in needed — and it survives a restart.

## Why the token-route list is exactly one path

`register_token_route(path)` is **exact-path set membership**, and a registered path is handed to
the bearer-**only** seam, which answers `401` *before* the cookie gate is consulted. So a
registered path can no longer be used by the browser. Measured 2026-10-11
(`../logs/p0.1-spike.txt`):

```
GET /api/profiles/sessions/sidebar  (registered)  no credentials -> 401
        {"error":"unauthenticated","detail":"Unauthorized"}          <- the seam's body
GET /api/profiles                   (unregistered) no credentials -> 401
        {"error":"unauthenticated",...,"reason":"no_cookie","login_url":"/login"}  <- the gate
```

The dashboard SPA calls `/api/profiles` and `POST /api/auth/ws-ticket` **with cookies**, so
registering either would break the user's own dashboard. The list is therefore one path —
`/api/profiles/sessions/sidebar`, the only route the app needs that the SPA never calls — and
everything else (including the WS-ticket route, which requires `request.state.session`) is
carried by `verify_session`.

## Deploy / update

```bash
server/install.sh            # copies this directory into ~/.hermes/plugins/ and enables it
```

Then, once:

```bash
# 1. the secret (never committed, never echoed)
printf 'HERMES_PERSONAE_BEARER=%s\n' "$(openssl rand -hex 32)" >> ~/.hermes/.env
chmod 600 ~/.hermes/.env
# 2. restart the dashboard so it picks the variable up (drops the dashboard for a few seconds)
systemctl --user restart hermes-serve.service
```

After that first restart, later **plugin** edits need no restart: an authenticated
`POST /api/dashboard/agent-plugins/activate {"name":"personae-mobile-auth","home":"$HOME/.hermes"}`
(the bearer works as the Authorization header once the provider is live) re-loads it in-process.

`install.sh` diffs the deployed copy against this directory, so drift between the source of
record and the live install is reported rather than silently tolerated.
