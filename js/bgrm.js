/* bgrm.js — in-browser background removal for uploaded mask art.
 * Two engines, both 100% client-side:
 *   1. "Quick"  — offline flood-fill from borders (GEOM.removeBackgroundFlood)
 *   2. "AI"     — @imgly/background-removal (isnet ONNX, streamed from CDN on
 *                 first use; ~40 MB, cached by the browser afterwards)
 */
import { removeBackgroundFlood } from './geom.js';

export const TEX_SIZE = 1024;

/** Load a File/Blob into an HTMLImageElement. */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

export function bitmapFromCanvas(canvas) {
  return createImageBitmap(canvas);
}

/** Letterbox any image into a transparent TEX_SIZE² canvas (keeps aspect). */
export function toMaskCanvas(source) {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  const ctx = c.getContext('2d');
  const sw = source.width || source.videoWidth, sh = source.height || source.videoHeight;
  const s = Math.min(TEX_SIZE / sw, TEX_SIZE / sh);
  const w = sw * s, h = sh * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, (TEX_SIZE - w) / 2, (TEX_SIZE - h) / 2, w, h);
  return c;
}

/** Quick offline removal: flood fill + feather. Returns new canvas. */
export function quickRemoveBackground(srcCanvas, tolerance = 30) {
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const out = removeBackgroundFlood(imgData, { tolerance, feather: 1.5 });
  const c = document.createElement('canvas');
  c.width = srcCanvas.width; c.height = srcCanvas.height;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

/** How much of the border looks like one flat color (0..1). Used to decide
 * whether quick removal will work well. */
export function borderUniformity(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  const idx = [];
  for (let x = 0; x < w; x += 2) { idx.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y += 2) { idx.push(y * w, y * w + w - 1); }
  for (const i of idx) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; }
  r /= n; g /= n; b /= n;
  let varSum = 0;
  for (const i of idx) {
    varSum += (d[i * 4] - r) ** 2 + (d[i * 4 + 1] - g) ** 2 + (d[i * 4 + 2] - b) ** 2;
  }
  const rms = Math.sqrt(varSum / n);
  return Math.max(0, 1 - rms / 60);
}

/** AI removal via @imgly/background-removal (dynamic CDN import). */
export async function aiRemoveBackground(srcCanvas, onProgress) {
  const mod = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
  const removeBackground = mod.removeBackground || mod.default?.removeBackground;
  if (!removeBackground) throw new Error('removeBackground not exported');
  // the library takes Blob/URL/arraybuffer — not a canvas
  const srcBlob = await new Promise((res, rej) => srcCanvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  const configs = [
    { model: 'isnet_quint8', output: { format: 'image/png' }, progress: onProgress },
    { output: { format: 'image/png' }, progress: onProgress },
  ];
  let blob = null, lastErr = null;
  for (const cfg of configs) {
    try { blob = await removeBackground(srcBlob, cfg); break; }
    catch (e) { lastErr = e; console.warn('imgly config failed', cfg.model, e); }
  }
  if (!blob) throw lastErr || new Error('AI background removal failed');
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
