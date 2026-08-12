"""
Regenerate the Traditional → Simplified character table embedded in matching.js.

The table is generated rather than hand-written, and inlined rather than
pulled from a CDN, because it has to run in three places: the browser, the
Cloudflare Worker (no runtime remote imports) and the Node test scripts.

Usage:
  pip install opencc
  python tools/gen_zh_table.py          # prints the two JS string constants
  python tools/gen_zh_table.py --check  # verify matching.js is up to date

Paste the printed constants over the TRADITIONAL_CHARS / SIMPLIFIED_CHARS
declarations in matching.js.
"""

import sys
import re
import os

import opencc

# t2s is the general Traditional → Simplified dictionary; tw2s and hk2s add
# the Taiwan- and Hong-Kong-specific variants KKBOX's catalogue uses.  Where
# they disagree (three characters today), the first listed wins.
CONVERTERS = ("t2s", "tw2s", "hk2s")

# CJK Unified Ideographs, Extension A, and Compatibility Ideographs — every
# block a song title realistically draws Traditional characters from.
RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF))

MATCHING_JS = os.path.join(os.path.dirname(__file__), os.pardir, "matching.js")


def build_table():
    """Map each Traditional character to its Simplified form, one char to one."""
    converters = [opencc.OpenCC(name) for name in CONVERTERS]
    table = {}
    for low, high in RANGES:
        for codepoint in range(low, high + 1):
            char = chr(codepoint)
            for converter in converters:
                folded = converter.convert(char)
                if len(folded) == 1 and folded != char:
                    table[char] = folded
                    break
    return table


def as_js_constant(name, chars, width=64):
    lines = [
        "  '" + chars[i:i + width].replace("\\", "\\\\").replace("'", "\\'") + "' +"
        for i in range(0, len(chars), width)
    ]
    lines[-1] = lines[-1].rstrip(" +") + ";"
    return f"const {name} =\n" + "\n".join(lines)


def read_embedded(name):
    with open(MATCHING_JS, encoding="utf-8") as handle:
        source = handle.read()
    match = re.search(rf"const {name} =\n((?:\s*'[^\n]*\n)+)", source)
    if not match:
        raise SystemExit(f"{name} not found in matching.js")
    return "".join(re.findall(r"'([^']*)'", match.group(1)))


def main():
    table = build_table()
    traditional = "".join(table.keys())
    simplified = "".join(table.values())

    if "--check" in sys.argv:
        ok = (read_embedded("TRADITIONAL_CHARS") == traditional
              and read_embedded("SIMPLIFIED_CHARS") == simplified)
        print("matching.js is up to date" if ok else "matching.js is STALE — regenerate")
        sys.exit(0 if ok else 1)

    print(f"// {len(table)} mappings", file=sys.stderr)
    print(as_js_constant("TRADITIONAL_CHARS", traditional))
    print()
    print(as_js_constant("SIMPLIFIED_CHARS", simplified))


if __name__ == "__main__":
    main()
