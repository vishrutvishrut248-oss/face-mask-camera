#!/usr/bin/env python3
"""Encode tests/testface.jpg into a looping Y4M (I420) file so headless
Chromium's --use-file-for-fake-video-capture can serve a real face to
getUserMedia during the smoke test."""
from PIL import Image
import numpy as np

W, H, FPS, FRAMES = 640, 480, 30, 60

img = Image.open('tests/testface.jpg').convert('RGB')
# cover-crop to 4:3
src_ratio = img.width / img.height
dst_ratio = W / H
if src_ratio > dst_ratio:
    nw = int(img.height * dst_ratio)
    img = img.crop(((img.width - nw) // 2, 0, (img.width + nw) // 2, img.height))
else:
    nh = int(img.width / dst_ratio)
    img = img.crop((0, (img.height - nh) // 2, img.width, (img.height + nh) // 2))
img = img.resize((W, H), Image.LANCZOS)
rgb = np.asarray(img).astype(np.float64)
R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
Y = np.clip(0.257 * R + 0.504 * G + 0.098 * B + 16, 0, 255)
U = np.clip(-0.148 * R - 0.291 * G + 0.439 * B + 128, 0, 255)
V = np.clip(0.439 * R - 0.368 * G - 0.071 * B + 128, 0, 255)

def plane(a, sx=1, sy=1):
    a = a[::sy, ::sx]
    return a.astype(np.uint8).tobytes()

frame = b'FRAME\n' + plane(Y) + plane(U, 2, 2) + plane(V, 2, 2)
with open('tests/face.y4m', 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420\n'.encode())
    for _ in range(FRAMES):
        f.write(frame)
print('wrote tests/face.y4m', W, H, FRAMES, 'frames')
