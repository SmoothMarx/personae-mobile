#!/usr/bin/env bash
# Run the server-plugin pytest suites in the DASHBOARD's own runtime (python 3.14 + its fastapi),
# without installing anything into it: pytest is borrowed (appended, never shadowing) from the
# legacy hermes-agent venv, where it is pure Python.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PYBIN="$(ls -d "$HOME"/.hermes/tools/python-3.14*/bin/python3 | head -1)"
PYTEST_SITE="${PYTEST_SITE:-$HOME/.hermes/hermes-agent/venv/lib/python3.11/site-packages}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
cd "$HERE"
exec "$PYBIN" -I -c "
import sys
sys.path.insert(0, '$HOME/.hermes/hermes-agent')
import hermes_bootstrap  # noqa: F401 — puts the dashboard runtime venv on sys.path
sys.path.append('$PYTEST_SITE')
import pytest
sys.exit(pytest.main(['-p', 'no:cacheprovider', '-q', *sys.argv[1:]]))
" "${@:-.}"
