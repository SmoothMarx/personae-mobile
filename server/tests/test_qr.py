"""qr.py — bit-for-bit against segno (an independent encoder) when it is importable.

segno is NOT in the dashboard runtime (that is the point of qr.py); on this box it lives in the
legacy ~/.hermes/venv (python 3.11, pure Python), which the test appends to sys.path. Without it the
oracle test is skipped and only the structural checks run.
"""
from __future__ import annotations

import glob
import os
import sys

import pytest

from conftest import AUTH_DIR, load_module

qr = load_module("personae_mobile_auth_qr", AUTH_DIR / "qr.py")

LINK = ("personae://connect?base=http%3A%2F%2F100.64.0.11%3A9119&code=" + "Ab9_-" * 9
        + "&label=the user%27s%20Pixel%208&expires=1760190000")


def _segno():
    for site in glob.glob(os.path.expanduser("~/.hermes/venv/lib/python3*/site-packages")):
        if site not in sys.path:
            sys.path.append(site)
    try:
        import segno  # noqa: F401
        from segno import consts  # noqa: F401
        return segno
    except Exception:
        return None


def test_structure_finders_timing_and_size():
    m = qr.encode(LINK)
    n = len(m)
    assert (n - 17) % 4 == 0 and all(len(r) == n for r in m)
    for r0, c0 in ((0, 0), (0, n - 7), (n - 7, 0)):
        assert all(m[r0][c0 + i] for i in range(7)) and all(m[r0 + 6][c0 + i] for i in range(7))
    assert [m[6][i] for i in range(8, n - 8)] == [i % 2 == 0 for i in range(8, n - 8)]
    svg = qr.to_svg(LINK)
    assert svg.startswith("<svg") and svg.endswith("</svg>")


@pytest.mark.parametrize("payload", ["hi", LINK, "x" * 300, "y" * 700, "z" * 900])
def test_matrix_matches_segno_for_every_mask(payload):
    segno = _segno()
    if segno is None:
        pytest.skip("segno not available on this host")
    from segno import consts
    ver = (len(qr.encode(payload)) - 17) // 4
    ecs = consts.ECC[ver][consts.ERROR_LEVEL_M]
    assert sum(e.num_blocks for e in ecs) == qr._BLOCKS_M[ver]
    for mask in range(8):
        mine = qr.encode(payload, mask=mask, min_version=ver, _extra_zero_byte=True)
        theirs = segno.make(payload, error="m", mode="byte", version=ver, mask=mask,
                            boost_error=False)
        assert mine == [[bool(c) for c in row] for row in theirs.matrix], (ver, mask)


def test_too_long_payload_is_refused():
    with pytest.raises(ValueError):
        qr.encode("q" * 2000)
