"""Builds the Park Blue design font: M PLUS Rounded 1c (SIL OFL 1.1), weights 500/700/800.

The source is the npm package @fontsource/m-plus-rounded-1c (a dev dependency), which splits the
Japanese font into ~55-127 unicode-range chunks per weight. We keep only the glyphs the app uses
(UI text + park catalogs in public/js, all kana, ASCII), merge them, and write ONE small woff2 per
weight to public/fonts/. Anything else (e.g. text from APIs) falls back to the system font.

Re-run after adding new UI text:
    python3 -m venv /tmp/ftv && /tmp/ftv/bin/pip install fonttools brotli
    /tmp/ftv/bin/python scripts/build_fonts.py
"""
import os
import re
import tempfile
from fontTools.ttLib import TTFont
from fontTools.merge import Merger, Options
from fontTools import subset

PKG = 'node_modules/@fontsource/m-plus-rounded-1c'
WEIGHTS = (500, 700, 800)

files = ['public/index.html'] + [os.path.join('public/js', f) for f in os.listdir('public/js') if f.endswith('.js')] \
    + [os.path.join('public/js/parks', f) for f in os.listdir('public/js/parks')]
cps = set(range(0x20, 0x7f)) | set(range(0x3041, 0x3100))
for f in files:
    cps |= {ord(c) for c in open(f, encoding='utf-8').read()}


def ranges(block):
    out = []
    for r in re.search(r'unicode-range:\s*([^;]+);', block).group(1).split(','):
        a, _, b = r.strip()[2:].partition('-')
        out.append((int(a, 16), int(b or a, 16)))
    return out


with tempfile.TemporaryDirectory() as tmp:
    for w in WEIGHTS:
        css = open(os.path.join(PKG, f'{w}.css'), encoding='utf-8').read()
        parts = []
        for i, block in enumerate(css.split('@font-face')[1:]):
            rs = ranges(block)
            if not any(a <= c <= b for c in cps for a, b in rs):
                continue
            font = TTFont(os.path.join(PKG, 'files', re.search(r'files/([^)]+\.woff2)', block).group(1)))
            opt = subset.Options()
            opt.layout_features = ['*']
            opt.name_IDs = ['*']
            sub = subset.Subsetter(opt)
            sub.populate(unicodes=cps)
            sub.subset(font)
            font.flavor = None
            p = os.path.join(tmp, f'{w}-{i}.ttf')
            font.save(p)
            parts.append(p)
        merged = Merger(Options(drop_tables=['vhea', 'vmtx'])).merge(parts)
        merged.flavor = 'woff2'
        out = f'public/fonts/mplus-rounded-1c-{w}.woff2'
        merged.save(out)
        print(out, len(parts), 'chunks', os.path.getsize(out) // 1024, 'KB')
