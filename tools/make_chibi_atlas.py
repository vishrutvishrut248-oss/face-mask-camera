#!/usr/bin/env python3
"""Build the 9-expression chibi atlas (no server, no AI needed):
 1. slice the generated 3x3 sheet, border-flood remove the white bg
 2. align cells 1-8 to cell 0 by alpha-silhouette IoU (hair is identical in
    every cell => pixel-perfect head alignment, so expression switches
    never jump)
 3. normalize the common frame to 1024^2
 4. measure face features in cell 0 by color (blue irises, mouth, skin extents)
    -> prints the calib JSON to bake into js/gallery.js
 5. feather alpha, pack 3x3 atlas (768/cell)
"""
import os
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, 'assets', 'raw', 'chibi_sheet.png')
DST = os.path.join(BASE, 'assets', 'masks', 'chibi_atlas.png')
CELL_ATLAS = 768
TEX = 1024


def cut_bg(a):
    rgb = a[..., :3].astype(int)
    h, w = rgb.shape[:2]
    bg = rgb[0, 0]
    outside = np.abs(rgb - bg).sum(axis=2) < 90
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
    return a


def best_offset(ref, mov, max_off):
    """translation (dy, dx) maximizing alpha IoU on a small pyramid."""
    ra = (ref[..., 3] > 0)[::4, ::4]
    ma = (mov[..., 3] > 0)[::4, ::4]
    mo = max_off // 4
    best, bo = -1, (0, 0)
    for dy in range(-mo, mo + 1, 2):
        for dx in range(-mo, mo + 1, 2):
            ys = slice(max(0, dy), min(ma.shape[0], ma.shape[0] + dy))
            xs = slice(max(0, dx), min(ma.shape[1], ma.shape[1] + dx))
            ys2 = slice(max(0, -dy), max(0, -dy) + (ys.stop - ys.start))
            xs2 = slice(max(0, -dx), max(0, -dx) + (xs.stop - xs.start))
            if ys.stop - ys.start < 10:
                continue
            inter = (ma[ys, xs] & ra[ys2, xs2]).sum()
            union = (ma[ys, xs] | ra[ys2, xs2]).sum()
            iou = inter / max(1, union)
            if iou > best:
                best, bo = iou, (dy * 4, dx * 4)
    return bo, best


def components(mask):
    lab = np.zeros(mask.shape, np.int32)
    n = 0
    sizes = [0]
    H, W = mask.shape
    for y in range(H):
        for x in range(W):
            if mask[y, x] and lab[y, x] == 0:
                n += 1
                sz = 0
                dq = deque([(y, x)])
                lab[y, x] = n
                while dq:
                    cy, cx = dq.popleft()
                    sz += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny2, nx2 = cy + dy, cx + dx
                        if 0 <= ny2 < H and 0 <= nx2 < W and mask[ny2, nx2] and lab[ny2, nx2] == 0:
                            lab[ny2, nx2] = n
                            dq.append((ny2, nx2))
                sizes.append(sz)
    return lab, sizes


def centroid(lab, sizes, idx):
    ys, xs = np.where(lab == idx)
    return xs.mean(), ys.mean()


def main():
    sheet = Image.open(SRC).convert('RGBA')
    W, H = sheet.size
    cw, ch = W // 3, H // 3
    cells = []
    for r in range(3):
        for c in range(3):
            a = np.array(sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)))
            cells.append(cut_bg(a))

    offsets = [(0, 0)]
    for i in range(1, 9):
        (dy, dx), iou = best_offset(cells[0], cells[i], 160)
        offsets.append((dy, dx))
        print(f'cell {i}: offset=({dy},{dx}) iou={iou:.3f}')

    # common frame: paste each cell into a big canvas at its offset, then crop
    # the SAME square window (cell0's bbox, padded) from all of them.
    M = 220
    def big(cell, dy, dx):
        cv = np.zeros((cell.shape[0] + 2 * M, cell.shape[1] + 2 * M, 4), np.uint8)
        cv[M + dy:M + dy + cell.shape[0], M + dx:M + dx + cell.shape[1]] = cell
        return cv

    ref = big(cells[0], 0, 0)
    ys, xs = np.where(ref[..., 3] > 0)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    side = int(max(bw, bh) * 1.02)
    top = max(0, (y0 + y1) // 2 - side // 2)
    left = max(0, (x0 + x1) // 2 - side // 2)

    framed = []
    for i, cell in enumerate(cells):
        dy, dx = offsets[i]
        framed.append(big(cell, dy, dx)[top:top + side, left:left + side])

    # ---- measure features on cell 0 (normalized coords) ----
    c0 = framed[0]
    rgb = c0[..., :3].astype(int)
    blue = (rgb[..., 2] > 110) & (rgb[..., 2] - rgb[..., 0] > 40) & (rgb[..., 1] < rgb[..., 2])
    blue[:side // 2 // 2] = False                       # ignore stray top pixels
    lab, sizes = components(blue)
    order = np.argsort(sizes)[::-1]
    eyes = []
    for idx in order[1:]:
        if idx == 0 or sizes[idx] < 200:
            continue
        cx, cy = centroid(lab, sizes, idx)
        eyes.append((cx, cy, sizes[idx]))
        if len(eyes) == 2:
            break
    eyes.sort()
    (exL, eyL, _), (exR, eyR, _) = eyes[0], eyes[1]

    skin = (rgb[..., 0] > 200) & (rgb[..., 1] > 150) & (rgb[..., 1] < 220) & (rgb[..., 2] > 110) & (rgb[..., 2] < 200)
    sys_ = np.where(skin)
    skin_top, skin_bot = sys_[0].min(), sys_[0].max()

    mouthm = (rgb[..., 0] > 110) & (rgb[..., 0] - rgb[..., 2] > 30) & (rgb[..., 1] < 110)
    mouthm[:int(eyL) + 20, :] = False
    if mouthm.sum() > 50:
        my, mx = np.where(mouthm)
        mx_, my_ = mx.mean(), my.mean()
    else:
        mx_, my_ = (exL + exR) / 2, (eyL + skin_bot) / 2

    calib = [
        {'x': exL / side, 'y': eyL / side}, {'x': exR / side, 'y': eyR / side},
        {'x': (exL + exR) / 2 / side, 'y': (eyL + my_) / 2 / side},
        {'x': mx_ / side, 'y': my_ / side},
        {'x': (exL + exR) / 2 / side, 'y': skin_bot / side},
        {'x': (exL + exR) / 2 / side, 'y': skin_top / side},
    ]
    print('CALIB_JSON =', calib)

    atlas = Image.new('RGBA', (CELL_ATLAS * 3, CELL_ATLAS * 3))
    for i, fr in enumerate(framed):
        img = Image.fromarray(fr).resize((TEX, TEX), Image.LANCZOS)
        arr = np.array(img)
        # fade out the shirt/bottom so the head shell has no hard lower edge
        ys = np.arange(TEX) / TEX
        fade = 1 - np.clip((ys - 0.88) / 0.10, 0, 1) ** 2
        arr[..., 3] = (arr[..., 3] * fade[:, None]).astype(np.uint8)
        img = Image.fromarray(arr)
        al = img.getchannel('A').filter(ImageFilter.GaussianBlur(1.2))
        img.putalpha(al)
        img = img.resize((CELL_ATLAS, CELL_ATLAS), Image.LANCZOS)
        r, c = divmod(i, 3)
        atlas.paste(img, (c * CELL_ATLAS, r * CELL_ATLAS))
    atlas.save(DST)
    a = np.array(atlas)
    print(f'atlas {atlas.size} opaque={int((a[..., 3] > 0).sum())} -> {DST}')


if __name__ == '__main__':
    main()
