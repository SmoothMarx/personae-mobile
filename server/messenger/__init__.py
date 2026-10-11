"""Messenger — agent-side stub.

The real surface of this plugin is the **desktop** half
(``desktop/plugin.js``, copied by the app into
``$HERMES_HOME/desktop-plugins/messenger/plugin.js``) plus this package's
``dashboard/plugin_api.py`` backend, mounted at ``/api/plugins/messenger/``.

Nothing needs to run in the agent process: no tools, no hooks, no commands. This
module exists so the plugin is a well-formed directory plugin that
``hermes plugins enable/disable``, ``hermes plugins doctor`` and the
``plugins.enabled`` trust gate can address by name.
"""

from __future__ import annotations


def register(ctx) -> None:  # noqa: ARG001 - contract signature requires the context
    """No agent-side contributions by design (desktop + dashboard plugin)."""
    return None
