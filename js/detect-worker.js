/* detect-worker.js — MediaPipe FaceLandmarker in a dedicated worker.
 * Runs the WASM inference OFF the main thread so rendering can hold 60 fps.
 * Protocol:
 *   main → { type:'init' }
 *   main → { type:'detect', bitmap: ImageBitmap (transferred), t: number }
 *   worker → { type:'ready', delegate }
 *   worker → { type:'result', t, lms: Float32Array(478*3) | null,
 *              bs: Float32Array(52) | null, names: string[], mtx: Float32Array(16) | null }
 */
/* Classic worker (MediaPipe's wasm glue uses importScripts, which module
 * workers forbid) — the ESM bundle is pulled in via dynamic import(). */

let FilesetResolver, FaceLandmarker;

const wasmUrl = () => new URL('../vendor/mediapipe/wasm/', self.location.href).href;
const modelUrl = () => new URL('../vendor/face_landmarker.task', self.location.href).href;

let lm = null;
let busy = false;

const base = {
  runningMode: 'VIDEO',
  numFaces: 1,
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  minFaceDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  minPresenceConfidence: 0.5,
};

async function init() {
  ({ FilesetResolver, FaceLandmarker } = await import(
    new URL('../vendor/mediapipe/vision_bundle.mjs', self.location.href).href
  ));
  const vision = await FilesetResolver.forVisionTasks(wasmUrl());
  let delegate = 'GPU';
  try {
    lm = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl(), delegate: 'GPU' }, ...base,
    });
  } catch (e) {
    delegate = 'CPU';
    lm = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl(), delegate: 'CPU' }, ...base,
    });
  }
  self.postMessage({ type: 'ready', delegate });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { init().catch((err) => self.postMessage({ type: 'error', msg: String(err) })); return; }
  if (m.type !== 'detect') return;
  if (!lm || busy) { try { m.bitmap && m.bitmap.close(); } catch {} return; }
  busy = true;
  try {
    const res = lm.detectForVideo(m.bitmap, m.t);
    let lms = null, bs = null, names = null, mtx = null;
    if (res.faceLandmarks && res.faceLandmarks.length) {
      const p = res.faceLandmarks[0];
      lms = new Float32Array(p.length * 3);
      for (let i = 0; i < p.length; i++) { lms[i * 3] = p[i].x; lms[i * 3 + 1] = p[i].y; lms[i * 3 + 2] = p[i].z; }
    }
    if (res.faceBlendshapes && res.faceBlendshapes.length) {
      const cats = res.faceBlendshapes[0].categories;
      bs = new Float32Array(cats.map((c) => c.score));
      names = cats.map((c) => c.categoryName);
    }
    if (res.facialTransformationMatrixes && res.facialTransformationMatrixes.length) {
      mtx = Float32Array.from(res.facialTransformationMatrixes[0].data);
    }
    const transfers = [];
    if (lms) transfers.push(lms.buffer);
    if (bs) transfers.push(bs.buffer);
    if (mtx) transfers.push(mtx.buffer);
    self.postMessage({ type: 'result', t: m.t, lms, bs, names, mtx }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', msg: String(err) });
  } finally {
    try { m.bitmap && m.bitmap.close(); } catch {}
    busy = false;
  }
};
