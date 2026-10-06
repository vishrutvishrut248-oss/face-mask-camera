/* face.js — MediaPipe Face Landmarker wrapper.
 *
 * Performance architecture: detection runs in a dedicated Web Worker
 * (js/detect-worker.js), so the WASM inference never blocks the main thread —
 * the render loop holds display rate (60 fps) while detection streams results
 * back at whatever cadence the device can afford. If workers fail (ancient
 * browsers), we fall back to inline main-thread detection.
 *
 * Outputs used downstream: 478 landmarks + 52 blendshapes + facial
 * transformation matrix (pose HUD + mask stabilization in scene.js).
 */
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

export class FaceTracker {
  constructor() {
    this.mode = null;            // 'worker' | 'inline' | null
    this.worker = null;
    this.landmarker = null;      // inline fallback only
    this.lastResult = null;
    this.busy = false;
    this.delegate = null;
    this.fpsSamples = [];
    this.detectFps = 0;
    this.onStatus = () => {};
    /** (result, tsMs, costMs) => void — called for every completed detection. */
    this.onResult = () => {};
  }

  async init() {
    this.onStatus('loading-wasm');
    try {
      await this._initWorker();
    } catch (e) {
      console.warn('worker detection unavailable, falling back to inline', e);
      try { this.worker && this.worker.terminate(); } catch {}
      this.worker = null;
      await this._initInline();
    }
    this.onStatus('ready');
  }

  async _initWorker() {
    const w = new Worker(new URL('./detect-worker.js', import.meta.url).href);
    this.worker = w;
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('worker init timeout')), 20000);
      w.onmessage = (e) => {
        if (e.data.type === 'ready') { clearTimeout(to); this.delegate = e.data.delegate; resolve(); }
        else if (e.data.type === 'error') { clearTimeout(to); reject(new Error(e.data.msg)); }
      };
      w.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ type: 'init' });
    });
    this.mode = 'worker';
    w.onmessage = (e) => this._onWorkerMsg(e.data);
    w.onerror = (e) => {
      console.warn('detect worker crashed — switching to inline', e);
      this._initInline().then(() => { this.onStatus('ready'); });
    };
  }

  _onWorkerMsg(m) {
    if (m.type === 'result') {
      this.busy = false;
      const result = FaceTracker.rebuildResult(m);
      this.lastResult = result;
      this._noteFps(m.t);
      const cost = this._sentAt ? performance.now() - this._sentAt : 0;
      this.onResult(result, m.t, cost);
    } else if (m.type === 'error') {
      this.busy = false;
      console.warn('worker detect error', m.msg);
    }
  }

  async _initInline() {
    const vision = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm/');
    const base = {
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      minPresenceConfidence: 0.5,
    };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate: 'GPU' }, ...base,
      });
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate failed, falling back to CPU', e);
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate: 'CPU' }, ...base,
      });
      this.delegate = 'CPU';
    }
    this.mode = 'inline';
  }

  /** Reconstruct a MediaPipe-shaped result object from worker arrays. */
  static rebuildResult(m) {
    const result = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
    if (m.lms) {
      const pts = new Array(m.lms.length / 3);
      for (let i = 0; i < pts.length; i++) {
        pts[i] = { x: m.lms[i * 3], y: m.lms[i * 3 + 1], z: m.lms[i * 3 + 2] };
      }
      result.faceLandmarks.push(pts);
    }
    if (m.bs) {
      const names = m.names || [];
      result.faceBlendshapes.push({
        categories: Array.from(m.bs, (score, i) => ({ categoryName: names[i] || `bs${i}`, score })),
      });
    }
    if (m.mtx) result.facialTransformationMatrixes.push({ data: m.mtx });
    return result;
  }

  /** Ask for a detection of the current video frame (fire-and-forget).
   *  Worker mode: zero-copy ImageBitmap transfer; never blocks rendering. */
  requestDetect(video, t) {
    if (this.mode === 'worker') {
      if (this.busy || !this.worker || video.readyState < 2 || video.videoWidth === 0) return;
      this.busy = true;
      const sentAt = performance.now();
      createImageBitmap(video).then((bm) => {
        if (!this.worker) { try { bm.close(); } catch {} this.busy = false; return; }
        this.worker.postMessage({ type: 'detect', bitmap: bm, t }, [bm]);
        // cost measured as round-trip in onResult via sentAt
        this._sentAt = sentAt;
      }).catch(() => { this.busy = false; });
      return;
    }
    if (this.mode === 'inline') {
      if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) return;
      const t0 = performance.now();
      try {
        const result = this.landmarker.detectForVideo(video, t);
        this.lastResult = result;
        this._noteFps(t);
        this.onResult(result, t, performance.now() - t0);
      } catch (e) {
        console.warn('detect failed', e);
      }
    }
  }

  _noteFps(ts) {
    this.fpsSamples.push(ts);
    while (this.fpsSamples.length > 2 && ts - this.fpsSamples[0] > 1000) this.fpsSamples.shift();
    if (this.fpsSamples.length > 2) {
      this.detectFps = (this.fpsSamples.length - 1) * 1000 / (ts - this.fpsSamples[0]);
    }
  }

  static blendshape(result, name) {
    if (!result || !result.faceBlendshapes || !result.faceBlendshapes.length) return 0;
    for (const c of result.faceBlendshapes[0].categories) if (c.categoryName === name) return c.score;
    return 0;
  }

  /** 4x4 facial transformation matrix as plain array of 16, or null. */
  static faceMatrix(result) {
    if (!result || !result.facialTransformationMatrixes || !result.facialTransformationMatrixes.length) return null;
    const m = result.facialTransformationMatrixes[0].data;
    return m ? Array.from(m) : null;
  }

  close() {
    try { this.worker && this.worker.terminate(); } catch {}
    this.worker = null;
    if (this.landmarker) this.landmarker.close();
    this.landmarker = null;
  }
}
