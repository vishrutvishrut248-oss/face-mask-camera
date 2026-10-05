#!/usr/bin/env python3
"""Offline cutout for the 3 built-in masks: flood-fill from the border with a
tight tolerance (respects the thin outline of the kitsune art), feather the
alpha, then letterbox into 512x512 like the in-app pipeline."""
from PIL import Image
import numpy as np
from collections import deque

TEX = 1024

def cutout(img: Image.Image, feather_passes: int = 2) -> Image.Image:
    """Chroma-key cutout for art rendered on a solid magenta backdrop:
    magenta-ish pixels connected to the border become transparent."""
    a = np.asarray(img.convert('RGB')).astype(np.int32)
    h, w, _ = a.shape
    mag = np.array([255, 0, 255])
    dist = np.sqrt(((a - mag) ** 2).sum(axis=2))
    is_magenta = dist < 150

    is_bg = np.zeros((h, w), dtype=np.uint8)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_magenta[y, x]:
                is_bg[y, x] = 1
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if is_magenta[y, x]:
                is_bg[y, x] = 1
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not is_bg[ny, nx] and is_magenta[ny, nx]:
                is_bg[ny, nx] = 1
                q.append((ny, nx))

    alpha = (1 - is_bg).astype(np.float32)
    for _ in range(feather_passes):
        alpha = (alpha
                 + np.roll(alpha, 1, 0) + np.roll(alpha, -1, 0)
                 + np.roll(alpha, 1, 1) + np.roll(alpha, -1, 1)) / 5.0
    out = np.dstack([a, (alpha * 255).round()]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')

def letterbox(img: Image.Image, size: int = TEX) -> Image.Image:
    c = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    s = min(size / img.width, size / img.height)
    w, h = int(img.width * s), int(img.height * s)
    img = img.resize((w, h), Image.LANCZOS)
    c.paste(img, ((size - w) // 2, (size - h) // 2), img)
    return c

for name in ['kitsune', 'robot', 'cat']:
    src = Image.open(f'assets/raw/{name}.png')
    cut = cutout(src)
    final = letterbox(cut)
    final.save(f'assets/masks/{name}.png', optimize=True)
    arr = np.asarray(final)
    opaque = (arr[..., 3] > 200).sum()
    trans = (arr[..., 3] < 20).sum()
    print(name, 'opaque px:', opaque, 'transparent px:', trans, 'size:', final.size)
