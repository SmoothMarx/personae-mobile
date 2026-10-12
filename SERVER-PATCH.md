# SERVER-PATCH.md — what this release touches on the box, and how to reapply it

Personae Mobile 0.9.0 (Phase A) adds a server surface. This file is the one-pass reapplication
recipe, written for the day `hermes update` has run and something looks missing.

**Rule §4 of the goal: the server patch must survive `hermes update`.** Measured answer:

> **NOTHING IS TOUCHED UNDER `~/.hermes/hermes-agent` AT ALL.**
> No core file is edited, added to, or shadowed. Every line of 0.9.0's server work is a **new plugin**
> under `~/.hermes/plugins/`, which is user data. `hermes update` refreshes the install tree; it does
> not delete or rewrite user plugins.

```
$ ls server/personae-mobile-state
__init__.py  dashboard/  plugin.yaml

$ grep -rn 'personae-mobile-state' server/install.sh
  [personae-mobile-state]="__init__.py plugin.yaml dashboard/manifest.json dashboard/plugin_api.py dashboard/preferences.py"
  PLUGIN_NAMES=(personae-mobile-auth personae-mobile-state messenger)
```

## What is deployed, and where

| repo file (source of record) | deployed to | kind |
|---|---|---|
| `server/personae-mobile-state/__init__.py` | `~/.hermes/plugins/personae-mobile-state/__init__.py` | new |
| `server/personae-mobile-state/plugin.yaml` | `~/.hermes/plugins/personae-mobile-state/plugin.yaml` | new |
| `server/personae-mobile-state/dashboard/manifest.json` | `~/.hermes/plugins/personae-mobile-state/dashboard/manifest.json` | new |
| `server/personae-mobile-state/dashboard/plugin_api.py` | `~/.hermes/plugins/personae-mobile-state/dashboard/plugin_api.py` | new |
| `server/personae-mobile-state/dashboard/preferences.py` | `~/.hermes/plugins/personae-mobile-state/dashboard/preferences.py` | new |
| `server/install.sh` | (repo only) | edited: one `FILES` entry, one `PLUGIN_NAMES` array |

**No existing plugin is edited either.** An earlier draft added a `preferences-v1` key to the messenger
plugin's `SHARED_KEYS` (`server/messenger/dashboard/ui_state.py`); that edit was **dropped**, because the
preference document has its own file and its own per-key revs, and reusing the layout store's
*entry-wise* merge would have silently turned per-preference LWW into per-document LWW. One fewer edit
to an existing file is one fewer thing an update can half-break.

## Reapply in one pass

```bash
cd ~/Projects/personae-mobile
server/install.sh --check      # report drift only; exit 1 when the deployed copy differs
server/install.sh              # copy changed files, enable the plugin if it is not in config.yaml
```

`install.sh` is idempotent (a second run changes nothing) and never touches a plugin's `state/`
directory. It reads no secret and prints none.

## The change does not take effect until the dashboard restarts — deliberately

`hermes-serve.service` serves the live dashboard on `:9119`, and **rule §3 of the goal forbids
restarting it from inside a tool call** (a previous run killed a live session doing exactly that). So
the deployment is performed and the *effect* is deferred:

* the plugin's routes mount **the next time `hermes-serve` starts** (a reboot, a manual update, or an
  ordinary restart by whoever owns the box);
* until then the app behaves exactly as it does today: `GET /health` on the plugin prefix answers
  `404`, the app's `stateAvailable()` probe records that, and archive/delete fall back to the
  dashboard's own `PATCH`/`DELETE` verbs — which is what 0.8.0 did, so **nothing regresses while the
  patch is dormant**. That fallback is asserted:
  `0.9.0 A: without the plugin the same verbs FALL BACK to the dashboard verbs`.

If a restart is wanted, do it OUTSIDE any process living in `hermes-serve`'s cgroup, as
`install.sh`'s own closing note says:

```bash
systemd-run --user --collect --unit=hs-restart-$(date +%s) \
  bash -lc 'sleep 2; systemctl --user restart hermes-serve.service'
```

## How "the surface still answers after the change" is proved

The goal (§4) accepts no note here, so there are two proofs and neither is a comment:

1. **in the suite, against the router itself** — `server/tests/test_state.py::test_9_0_A_the_surface_answers_after_the_change`
   mounts the plugin's `router` on a FastAPI app and asserts every route it publishes answers:
   `GET /health` (exact body), `GET /preferences`, `GET /preferences/keys`. The same file drives the
   two verbs through a spy on core's own endpoint functions, so "the verbs ARE the dashboard's verbs"
   is a counted call, not a claim.
2. **against the running dashboard** — `logs/verify-0.9.0.sh` re-measures the live surface
   (`/api/profiles/sessions/sidebar`, `/pair`) on the already-running `:9119` process, and reports the
   state plugin as *dormant* (404) rather than failed when it has not been restarted into existence.
   A 404 there is the documented state above, printed as such.

## Rolling back

```bash
rm -rf ~/.hermes/plugins/personae-mobile-state
# and remove `personae-mobile-state` from the `plugins:` list in ~/.hermes/config.yaml
```

Nothing else is left behind: the plugin writes only
`~/.hermes/plugins/personae-mobile-state/state/preferences-<profile>.json` (0600) and its `.lock`
sibling. Removing the plugin removes the routes; the app's probe then records `unavailable` and falls
back, exactly as it does for an older server.
