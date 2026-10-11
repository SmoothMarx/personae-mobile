"""Minimal, dependency-free QR Code encoder (byte mode, ECC level M) -> SVG.

Written for this plugin so the /pair page can show a QR with no network fetch and no new pip
dependency (``segno``/``qrcode`` are not in the dashboard venv). Algorithm per ISO/IEC 18004
(the same structure as Project Nayuki's public-domain-style reference): Reed-Solomon over GF(256)
with 0x11D, block interleaving, function patterns, zig-zag placement, 8 masks scored with the four
standard penalty rules. Versions 1-25 (up to 997 bytes at level M) — far beyond a deep link.

Correctness is pinned by ``tests/test_qr.py``, which compares the module matrix against ``segno``
(installed in a *different* venv on this box) for several payloads, versions and every mask.
"""
from __future__ import annotations

from typing import List

# Level M only (format bits 0b00). Index = version.
_ECC_PER_BLOCK_M = (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
                    26, 26, 28, 28, 28, 28)
_BLOCKS_M = (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20,
             21)
MAX_VERSION = 25
_FORMAT_ECL_M = 0


def _raw_data_modules(ver: int) -> int:
    result = (16 * ver + 128) * ver + 64
    if ver >= 2:
        numalign = ver // 7 + 2
        result -= (25 * numalign - 10) * numalign - 55
        if ver >= 7:
            result -= 36
    return result


def _data_codewords(ver: int) -> int:
    return _raw_data_modules(ver) // 8 - _ECC_PER_BLOCK_M[ver] * _BLOCKS_M[ver]


def _rs_mul(x: int, y: int) -> int:
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree: int) -> List[int]:
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _rs_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _rs_mul(root, 0x02)
    return result


def _rs_remainder(data: List[int], divisor: List[int]) -> List[int]:
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _rs_mul(coef, factor)
    return result


def _alignment_positions(ver: int) -> List[int]:
    if ver == 1:
        return []
    size = ver * 4 + 17
    numalign = ver // 7 + 2
    step = (ver * 8 + numalign * 3 + 5) // (numalign * 4 - 4) * 2
    result = [size - 7 - i * step for i in range(numalign - 1)] + [6]
    return list(reversed(result))


class _Qr:
    def __init__(self, ver: int, data_codewords: List[int], mask: int = -1) -> None:
        self.ver = ver
        self.size = ver * 4 + 17
        n = self.size
        self.modules = [[False] * n for _ in range(n)]
        self.function = [[False] * n for _ in range(n)]
        self._draw_function_patterns()
        allcw = self._add_ecc_and_interleave(data_codewords)
        self._draw_codewords(allcw)
        if mask == -1:
            best, best_penalty = 0, None
            for m in range(8):
                self._apply_mask(m)
                self._draw_format_bits(m)
                p = self._penalty()
                if best_penalty is None or p < best_penalty:
                    best, best_penalty = m, p
                self._apply_mask(m)  # XOR undo
            mask = best
        self.mask = mask
        self._apply_mask(mask)
        self._draw_format_bits(mask)

    # -- function patterns --------------------------------------------------------------------
    def _set_fn(self, x: int, y: int, dark: bool) -> None:
        self.modules[y][x] = dark
        self.function[y][x] = True

    def _draw_function_patterns(self) -> None:
        n = self.size
        for i in range(n):
            self._set_fn(6, i, i % 2 == 0)
            self._set_fn(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (n - 4, 3), (3, n - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < n and 0 <= y < n:
                        self._set_fn(x, y, max(abs(dx), abs(dy)) not in (2, 4))
        pos = _alignment_positions(self.ver)
        last = len(pos) - 1
        for i, px in enumerate(pos):
            for j, py in enumerate(pos):
                if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self._set_fn(px + dx, py + dy, max(abs(dx), abs(dy)) != 1)
        self._draw_format_bits(0)  # reserve
        self._draw_version()

    def _draw_format_bits(self, mask: int) -> None:
        data = _FORMAT_ECL_M << 3 | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = (data << 10 | rem) ^ 0x5412
        n = self.size

        def bit(i: int) -> bool:
            return (bits >> i) & 1 != 0

        for i in range(0, 6):
            self._set_fn(8, i, bit(i))
        self._set_fn(8, 7, bit(6))
        self._set_fn(8, 8, bit(7))
        self._set_fn(7, 8, bit(8))
        for i in range(9, 15):
            self._set_fn(14 - i, 8, bit(i))
        for i in range(0, 8):
            self._set_fn(n - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self._set_fn(8, n - 15 + i, bit(i))
        self._set_fn(8, n - 8, True)

    def _draw_version(self) -> None:
        if self.ver < 7:
            return
        rem = self.ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = self.ver << 12 | rem
        n = self.size
        for i in range(18):
            dark = (bits >> i) & 1 != 0
            a, b = n - 11 + i % 3, i // 3
            self._set_fn(a, b, dark)
            self._set_fn(b, a, dark)

    # -- data -----------------------------------------------------------------------------------
    def _add_ecc_and_interleave(self, data: List[int]) -> List[int]:
        ver = self.ver
        numblocks = _BLOCKS_M[ver]
        blockecclen = _ECC_PER_BLOCK_M[ver]
        rawcodewords = _raw_data_modules(ver) // 8
        numshort = numblocks - rawcodewords % numblocks
        shortlen = rawcodewords // numblocks
        rsdiv = _rs_divisor(blockecclen)
        blocks, k = [], 0
        for i in range(numblocks):
            dat = data[k:k + shortlen - blockecclen + (0 if i < numshort else 1)]
            k += len(dat)
            ecc = _rs_remainder(dat, rsdiv)
            if i < numshort:
                dat = dat + [0]
            blocks.append(dat + ecc)
        result = []
        for i in range(len(blocks[0])):
            for j, blk in enumerate(blocks):
                if i != shortlen - blockecclen or j >= numshort:
                    result.append(blk[i])
        return result

    def _draw_codewords(self, data: List[int]) -> None:
        n = self.size
        i = 0
        right = n - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(n):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = (n - 1 - vert) if upward else vert
                    if not self.function[y][x] and i < len(data) * 8:
                        self.modules[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1 != 0
                        i += 1
            right -= 2

    def _apply_mask(self, mask: int) -> None:
        f = (
            lambda x, y: (x + y) % 2 == 0,
            lambda x, y: y % 2 == 0,
            lambda x, y: x % 3 == 0,
            lambda x, y: (x + y) % 3 == 0,
            lambda x, y: (x // 3 + y // 2) % 2 == 0,
            lambda x, y: x * y % 2 + x * y % 3 == 0,
            lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
            lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
        )[mask]
        for y in range(self.size):
            row, fn = self.modules[y], self.function[y]
            for x in range(self.size):
                if not fn[x] and f(x, y):
                    row[x] = not row[x]

    def _penalty(self) -> int:
        n, m = self.size, self.modules
        score = 0
        lines = [m[y] for y in range(n)] + [[m[y][x] for y in range(n)] for x in range(n)]
        pat_a = [True, False, True, True, True, False, True, False, False, False, False]
        pat_b = list(reversed(pat_a))
        for line in lines:
            run, prev = 0, None
            for v in line:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        score += 3 + run - 5
                    run, prev = 1, v
            if run >= 5:
                score += 3 + run - 5
            for i in range(n - 10):
                seg = line[i:i + 11]
                if seg == pat_a or seg == pat_b:
                    score += 40
        for y in range(n - 1):
            for x in range(n - 1):
                c = m[y][x]
                if c == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    score += 3
        dark = sum(sum(1 for v in row if v) for row in m)
        total = n * n
        k = abs(dark * 20 - total * 10) // total
        score += k * 10
        return score


def encode(text: str, *, mask: int = -1, min_version: int = 1,
           _extra_zero_byte: bool = False) -> List[List[bool]]:
    """Return the module matrix (rows of booleans, True = dark), no quiet zone.

    ``_extra_zero_byte`` is TEST-ONLY: segno (the oracle) appends 8 zero padding bits when the
    stream is already byte-aligned after the terminator. Readers ignore everything after the
    character count, so both forms decode identically; the flag lets the oracle test compare
    matrices bit-for-bit."""
    data = text.encode("utf-8")
    for ver in range(max(1, min_version), MAX_VERSION + 1):
        ccbits = 8 if ver <= 9 else 16
        capacity_bits = _data_codewords(ver) * 8
        if 4 + ccbits + len(data) * 8 <= capacity_bits:
            break
    else:
        raise ValueError("payload too long for this QR encoder")
    bits: List[int] = []

    def put(val: int, length: int) -> None:
        for i in reversed(range(length)):
            bits.append((val >> i) & 1)

    put(0b0100, 4)
    put(len(data), ccbits)
    for b in data:
        put(b, 8)
    put(0, min(4, capacity_bits - len(bits)))
    put(0, (-len(bits)) % 8)
    if _extra_zero_byte and len(bits) < capacity_bits:
        put(0, 8)
    pad = 0xEC
    while len(bits) < capacity_bits:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    codewords = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    return _Qr(ver, codewords, mask).modules


def to_svg(text: str, *, border: int = 4, scale: int = 8, dark: str = "#000",
           light: str = "#fff") -> str:
    """A crisp, self-contained SVG of the QR for ``text``."""
    matrix = encode(text)
    n = len(matrix)
    dim = n + border * 2
    parts = [f"M{x + border},{y + border}h1v1h-1z"
             for y, row in enumerate(matrix) for x, v in enumerate(row) if v]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" '
            f'width="{dim * scale}" height="{dim * scale}" shape-rendering="crispEdges">'
            f'<rect width="100%" height="100%" fill="{light}"/>'
            f'<path d="{"".join(parts)}" fill="{dark}"/></svg>')
