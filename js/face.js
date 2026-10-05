/* face.js — MediaPipe Face Landmarker wrapper.
 * - GPU delegate with CPU fallback
 * - 478 landmarks + 52 blendshapes + facial transformation matrix (used for
 *   pose HUD + mask stabilization in scene.js)
 * - FPS monitor with auto "lite mode" suggestion (target 30 fps)
 * - Lite mode: detect every 2nd frame (landmarks reused between)
 */
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.lastResult = null;
    this.lastVideoTime = -1;
    this.frameSkip = 1;        // 1 = every frame, 2 = lite
    this._skipCounter = 0;
    this.fpsSamples = [];
    this.detectFps = 0;
    this.onStatus = () => {};
  }

  async init() {
    this.onStatus('loading-wasm');
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
    this.onStatus('loading-model');
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate: 'GPU' },
        ...base,
      });
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate failed, falling back to CPU', e);
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate: 'CPU' },
        ...base,
      });
      this.delegate = 'CPU';
    }
    this.onStatus('ready');
  }

  setLite(on) { this.frameSkip = on ? 2 : 1; }

  /** Run detection for the current video frame. Returns result (possibly cached in lite mode). */
  detect(video) {
    if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) return this.lastResult;
    const ts = performance.now();
    this._skipCounter++;
    if (this.frameSkip > 1 && this._skipCounter % this.frameSkip !== 0 && this.lastResult) {
      return this.lastResult;
    }
    if (video.currentTime === this.lastVideoTime && this.lastResult) return this.lastResult;
    this.lastVideoTime = video.currentTime;
    try {
      const result = this.landmarker.detectForVideo(video, ts);
      // detectForVideo requires strictly increasing timestamps; guard duplicates
      this.lastResult = result;
      this._noteFps(ts);
      return result;
    } catch (e) {
      console.warn('detect failed', e);
      return this.lastResult;
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

  close() { if (this.landmarker) this.landmarker.close(); this.landmarker = null; }
}
