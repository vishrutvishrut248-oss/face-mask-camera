#!/usr/bin/env python3
"""Turn the user's anime portrait (plain light background) into a built-in
mask: border flood-fill removes the background (the artwork's own outline
encloses the figure, so this is exact), then crop-to-alpha + square-pad +
resize to 1024^2 like the other builtins."""
import sys
from collections import deque
import numpy as np
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else '/home/user/uploads/1790751478645.png'
DST = sys.argv[2] if len(sys.argv) > 2 else 'assets/masks/anime.png'
TEX = 1024

im = Image.open(SRC).convert('RGBA')
a = np.array(im)
rgb = a[..., :3].astype(int)
h, w = rgb.shape[:2]

bg = rgb[0, 0]
outside = np.abs(rgb - bg).sum(axis=2) < 84          # per-pixel vs bg color
rem = np.zeros((h, w), bool)
dq = deque()
for x in range(w):
    for y in (0, h - 1):
        if outside[y, x] and not rem[y, x]:
            rem[y, x] = True; dq.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if outside[y, x] and not rem[y, x]:
            rem[y, x] = True; dq.append((y, x))
while dq:
    y, x = dq.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and outside[ny, nx] and not rem[ny, nx]:
            rem[ny, nx] = True; dq.append((ny, nx))

a[..., 3][rem] = 0
ys, xs = np.where(a[..., 3] > 0)
if len(xs) == 0:
    sys.exit('nothing left after cutout!')
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
crop = a[y0:y1 + 1, x0:x1 + 1]

# square canvas with 1% breathing room, centered
ch, cw = crop.shape[:2]
side = int(max(ch, cw) * 1.02)
canvas = np.zeros((side, side, 4), np.uint8)
oy, ox = (side - ch) // 2, (side - cw) // 2
canvas[oy:oy + ch, ox:ox + cw] = crop

out = Image.fromarray(canvas).resize((TEX, TEX), getattr(Image,'Resampling',Image).LANCZOS)
out.save(DST)
print(f'opaque px: {int((np.array(out)[..., 3] > 0).sum())}  bbox {cw}x{ch} -> {TEX}^2 -> {DST}')
