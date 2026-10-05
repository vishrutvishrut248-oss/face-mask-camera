#!/usr/bin/env python3
"""Y4M with a simulated head turn: frames 0-29 frontal, 30-59 rotated 15 deg.
Used by tests/drift.py to prove the mask no longer drifts on head movement."""
from PIL import Image
import numpy as np

W, H, FPS = 640, 480, 30

img = Image.open('tests/testface.jpg').convert('RGB')
src_ratio = img.width / img.height
dst_ratio = W / H
if src_ratio > dst_ratio:
    nw = int(img.height * dst_ratio)
    img = img.crop(((img.width - nw) // 2, 0, (img.width + nw) // 2, img.height))
else:
    nh = int(img.width / dst_ratio)
    img = img.crop((0, (img.height - nh) // 2, img.width, (img.height + nh) // 2))
img = img.resize((W, H), Image.LANCZOS)
fill = tuple(int(c) for c in np.asarray(img)[2, 2])
turned = img.rotate(15, resample=Image.BICUBIC, expand=False, fillcolor=fill)

def i420(pil):
    a = np.asarray(pil).astype(np.float64)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    Y = np.clip(0.257 * R + 0.504 * G + 0.098 * B + 16, 0, 255)
    U = np.clip(-0.148 * R - 0.291 * G + 0.439 * B + 128, 0, 255)
    V = np.clip(0.439 * R - 0.368 * G - 0.071 * B + 128, 0, 255)
    return (Y.astype(np.uint8).tobytes() + U[::2, ::2].astype(np.uint8).tobytes()
            + V[::2, ::2].astype(np.uint8).tobytes())

f_front = b'FRAME\n' + i420(img)
f_turn = b'FRAME\n' + i420(turned)
with open('tests/turn.y4m', 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420\n'.encode())
    for i in range(60):
        f.write(f_turn if i >= 30 else f_front)
print('wrote tests/turn.y4m (front 1s -> turned 15deg 1s, looping)')
