/* scene.js — Three.js rendering: video background + texture-mapped face mesh.
 *
 * Perf/smoothness design:
 *   - Detection runs on its own cadence (main.js); the render loop interpolates
 *     between the last two landmark snapshots (sampled one interval in the
 *     past) so the mask glides even when detection runs at 10-15 Hz.
 *   - No per-frame allocations in the hot path; region vertex lists and the
 *     landmark->vertex lookup are precomputed once.
 *   - The facial transformation matrix feeds ONLY the pose HUD (it lives in cm
 *     while the mesh lives in screen units — applying it caused drift).
 * Mask UVs come from the calibration homography (image pts -> canonical UV
 * anchors); per-vertex alpha now covers the FULL face oval (not just the
 * 6-anchor hull) so masks cover the whole face.
 */
import * as THREE from '../vendor/three.module.min.js';
import { fitHomography, applyH, inv3x3, convexHull, signedDistToConvexPoly, smoothstep } from './geom.js';

/* Semantic anchors: canonical-mesh landmark indices for the 6 calibration pts.
 * Order MUST match the calibration UI order:
 *   0 leftEye  1 rightEye  2 nose  3 mouth  4 chin  5 forehead   (subject's L/R) */
export const ANCHOR_LANDMARKS = [
  [362, 263, 386, 374],  // left eye center
  [33, 133, 159, 145],   // right eye center
  [1],                   // nose tip
  [13, 14],              // mouth center
  [152],                 // chin
  [10],                  // forehead
];

/* Extra structural anchors (auto-detected on uploaded art) so the homography
 * fits the WHOLE face structure — mouth corners, brows, cheeks — not just the
 * 6 UI points. Order: L/R pairs adjacent for mirror swapping. */
export const EXTRA_ANCHOR_LANDMARKS = [
  [61],            // mouth corner L
  [291],           // mouth corner R
  [70, 104, 105],  // brow L
  [300, 344, 345], // brow R
  [234],           // cheek L
  [454],           // cheek R
];

/* MediaPipe FACE_OVAL — used to extend the alpha hull to the whole face. */
const FACE_OVAL = [10, 338, 297, 332, 284, 397, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

/* Blendshape puppet regions (canonical landmark indices). */
const REGION = {
  eyeR: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 25, 26, 27, 28, 29, 30, 56, 190],
  eyeL: [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382, 253, 254, 255, 256, 257, 258, 286, 414],
  mouth: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
          78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
  jaw: [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288,
        361, 323, 454, 356, 389, 251, 284, 332, 297, 338],
};

const MASK_VERT = /* glsl */`
  attribute float aAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MASK_FRAG = /* glsl */`
  uniform sampler2D map;
  uniform float uOpacity;
  uniform float uBlinkL; uniform float uBlinkR; uniform float uJaw;
  uniform vec2 uEyeL; uniform vec2 uEyeR; uniform vec2 uMouth;
  varying vec2 vUv;
  varying float vAlpha;

  /* AI expression transfer: warp the texture sample so the DRAWN eyes close
   * when your eyes close (blendshape-driven), and the drawn mouth opens with
   * your jaw. Sampling expands vertically around an eye => the drawn eye
   * collapses into a lash line; zooming into the mouth => drawn mouth opens. */
  vec2 warpEye(vec2 uv, vec2 c, float b) {
    vec2 d = uv - c;
    float w = 1.0 - smoothstep(0.06, 0.20, length(d * vec2(1.0, 1.7)));
    d.y *= 1.0 + (b * 2.2) * w;
    d.y -= 0.015 * b * w;
    return c + d;
  }
  vec2 warpMouth(vec2 uv, vec2 c, float j) {
    vec2 d = uv - c;
    float w = 1.0 - smoothstep(0.05, 0.18, length(d * vec2(1.0, 1.4)));
    d *= 1.0 - 0.5 * j * w;
    d.y -= 0.02 * j * w;
    return c + d;
  }
  void main() {
    vec2 uv = warpEye(vUv, uEyeL, uBlinkL);
    uv = warpEye(uv, uEyeR, uBlinkR);
    uv = warpMouth(uv, uMouth, uJaw);
    vec4 t = texture2D(map, clamp(uv, 0.0, 1.0));
    float a = t.a * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(t.rgb, a);
  }
`;

export class MaskScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.aspect = 16 / 9;
    this.camera = new THREE.OrthographicCamera(-this.aspect, this.aspect, 1, -1, -10, 10);
    this.camera.position.z = 5;

    // video plane
    this.videoTex = null;
    this.videoPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide }));
    this.scene.add(this.videoPlane);

    // mask mesh (built when OBJ + calibration available)
    this.maskMesh = null;
    this.obj = null;
    this.maskTexture = null;
    this.anchorUVs = null;
    this.calib = null;

    // debug landmark dots
    const dotsGeo = new THREE.BufferGeometry();
    dotsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(478 * 3), 3));
    this.dots = new THREE.Points(dotsGeo, new THREE.PointsMaterial({ color: 0x00ff88, size: 3, sizeAttenuation: false, depthTest: false }));
    this.dots.visible = false;
    this.dots.renderOrder = 10;
    this.scene.add(this.dots);

    // options
    this.mirror = true;
    this.opacity = 1;
    this.maskScale = 1;
    this.debugDots = false;
    this.expressionBoost = true;
    this.lite = false;
    this.dprCap = 1.5;

    // landmark interpolation snapshots (world-space, 468*3)
    this._snapPrev = new Float32Array(468 * 3);
    this._snapCurr = new Float32Array(468 * 3);
    this._work = new Float32Array(468 * 3);
    this._smW = new Float32Array(468 * 3);
    this._smInitW = false; this._smLast = 0; this._lastNow = 0; this._hadFace = false;
    this._tPrev = 0; this._tCurr = 0;
    this._hasFace = false;

    // pose HUD state (face matrix, smoothed) — HUD only, never applied to mesh
    this._smPos = new THREE.Vector3();
    this._smQuat = new THREE.Quaternion();
    this._smScale = new THREE.Vector3(1, 1, 1);
    this._smInit = false;
    this._tmpM = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._tmpS = new THREE.Vector3();
    this._euler = new THREE.Euler();
    this.pose = { yaw: 0, pitch: 0, roll: 0, dist: 1, tracking: false };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  attachVideo(video) {
    this.video = video;
    if (this.videoTex) this.videoTex.dispose();
    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.colorSpace = THREE.SRGBColorSpace;
    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.videoPlane.material.map = this.videoTex;
    this.videoPlane.material.color.set(0xffffff);
    this.videoPlane.material.needsUpdate = true;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const vw = this.video && this.video.videoWidth ? this.video.videoWidth : 16;
    const vh = this.video && this.video.videoHeight ? this.video.videoHeight : 9;
    this.aspect = vw / vh;
    this.camera.left = -this.aspect; this.camera.right = this.aspect;
    this.camera.top = 1; this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    this.videoPlane.scale.set(this.aspect, 1, 1);
  }

  setLite(on) {
    this.lite = on;
    this.dprCap = on ? 1 : 1.5;
    this.resize();
  }

  /* Build geometry from the canonical OBJ (once). */
  setFaceModel(obj) {
    this.obj = obj;
    this._vOfL = null;
    const n = obj.vertexCount;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setIndex(new THREE.BufferAttribute(obj.indices, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null }, uOpacity: { value: 1 },
        uBlinkL: { value: 0 }, uBlinkR: { value: 0 }, uJaw: { value: 0 },
        uEyeL: { value: new THREE.Vector2(0.35, 0.6) },
        uEyeR: { value: new THREE.Vector2(0.65, 0.6) },
        uMouth: { value: new THREE.Vector2(0.5, 0.3) },
      },
      vertexShader: MASK_VERT, fragmentShader: MASK_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.maskMesh = new THREE.Mesh(geo, mat);
    this.maskMesh.renderOrder = 5;
    this.maskMesh.frustumCulled = false;
    this.maskMesh.position.z = 0.001;
    this.scene.add(this.maskMesh);

    // Precompute anchor UVs in canonical texture space (vt, v-up).
    const groupUV = (group) => {
      let u = 0, v = 0;
      for (const li of group) {
        const vi = this._vertexForLandmark(li);
        u += obj.uvs[vi * 2]; v += obj.uvs[vi * 2 + 1];
      }
      return [u / group.length, v / group.length];
    };
    this.anchorUVs = ANCHOR_LANDMARKS.map(groupUV);
    this.anchorUVsExtra = EXTRA_ANCHOR_LANDMARKS.map(groupUV);

    // Precompute region vertex lists (unique vertices) for the puppet pass.
    this._regions = {};
    for (const key of Object.keys(REGION)) {
      const set = new Set();
      for (const li of REGION[key]) set.add(this._vertexForLandmark(li));
      this._regions[key] = Uint16Array.from(set);
    }
    if (this.maskTexture && this.calib) this.setMaskTexture(this.maskTexture.image, this.calib, this.maskFlip);
  }

  _vertexForLandmark(li) {
    if (!this._vOfL) {
      const map = this.obj.landmarkIndexOfVertex;
      this._vOfL = new Int32Array(478).fill(-1);
      for (let i = map.length - 1; i >= 0; i--) this._vOfL[map[i]] = i;
    }
    const v = this._vOfL[li];
    return v >= 0 ? v : li;
  }

  /* Mask texture = processed (bg-removed) canvas; calib = 6 pts {x,y} in
   * normalized image coords (v down), order ANCHOR_LANDMARKS. */
  setMaskTexture(canvasOrImage, calib, flip = false) {
    if (!this.obj || !this.maskMesh) return;
    if (this.maskTexture) this.maskTexture.dispose();
    const tex = new THREE.CanvasTexture(canvasOrImage);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.maskTexture = tex;
    this.maskMesh.material.uniforms.map.value = tex;
    this.calib = calib;
    this.maskFlip = flip;
    this.recomputeUVs();
  }

  /* Fit homography image->canonical UV from the 6 calibration points, then
   * invert it to get each mesh vertex's texture coordinate. Alpha now covers
   * the full face oval so the mask covers the whole face. */
  recomputeUVs() {
    if (!this.calib || !this.obj || !this.maskMesh) return;
    let pts = this.calib.map(p => [p.x, 1 - p.y]); // to texture space (v-up)
    if (this.maskFlip) {
      const flipped = pts.slice();
      flipped[0] = [1 - pts[1][0], pts[1][1]]; // left eye <- right eye (mirrored u)
      flipped[1] = [1 - pts[0][0], pts[0][1]];
      pts = flipped;
    }
    // extra structural pairs (auto-detected) tighten the fit to face structure
    const dst = this.anchorUVs.slice();
    if (this._autoPairs && this.anchorUVsExtra) {
      let pairs = this._autoPairs;
      if (this.maskFlip) {
        pairs = pairs.map(p => ({ img: [1 - p.img[0], p.img[1]], uv: p.uv }));
        for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) { const t = pairs[a]; pairs[a] = pairs[b]; pairs[b] = t; }
      }
      for (const p of pairs) { pts.push(p.img); dst.push(p.uv); }
    }
    const H = fitHomography(pts, dst);
    if (!H) return;
    // expression-transfer centers (drawn eye/mouth positions in texture space)
    const U = this.maskMesh.material.uniforms;
    U.uEyeL.value.set(pts[0][0], pts[0][1]);
    U.uEyeR.value.set(pts[1][0], pts[1][1]);
    U.uMouth.value.set(pts[3][0], pts[3][1]);
    const Hinv = inv3x3(H);
    if (!Hinv) return;

    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;

    const uvAttr = this.maskMesh.geometry.getAttribute('uv');
    const alphaAttr = this.maskMesh.geometry.getAttribute('aAlpha');
    // full-face coverage: hull of the 6 anchors + the face oval
    const hullPts = this.anchorUVs.slice();
    for (const li of FACE_OVAL) {
      const vi = this._vertexForLandmark(li);
      hullPts.push([this.obj.uvs[vi * 2], this.obj.uvs[vi * 2 + 1]]);
    }
    const hull = convexHull(hullPts);
    const s = Math.max(0.2, this.maskScale);

    for (let i = 0; i < this.obj.vertexCount; i++) {
      const u = this.obj.uvs[i * 2], v = this.obj.uvs[i * 2 + 1];
      let [tu, tv] = applyH(Hinv, u, v);
      tu = cx + (tu - cx) / s;
      tv = cy + (tv - cy) / s;
      uvAttr.setXY(i, tu, tv);
      const d = signedDistToConvexPoly(u, v, hull);
      alphaAttr.setX(i, 1 - smoothstep(0.03, 0.14, d));
    }
    uvAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  /** Extra auto-detected image<->canonical pairs for structural fitting. */
  setAutoPairs(pairs) {
    this._autoPairs = pairs || null;
    this.recomputeUVs();
  }

  /** Update calibration points without rebuilding the texture (live drag). */
  updateCalib(calib, flip) {
    this.calib = calib;
    if (flip !== undefined) this.maskFlip = flip;
    this.recomputeUVs();
  }

  setMaskScale(s) { this.maskScale = s; this.recomputeUVs(); }
  setOpacity(o) { this.opacity = o; }

  /** Store a new landmark snapshot (world space) for interpolation. */
  pushLandmarks(lms, ts) {
    this._snapPrev.set(this._snapCurr);
    this._tPrev = this._tCurr || ts;
    this._tCurr = ts;
    const a = this.aspect;
    for (let i = 0; i < 468 && i < lms.length; i++) {
      const lm = lms[i];
      const x = this.mirror ? 1 - lm.x : lm.x;
      this._snapCurr[i * 3] = (x - 0.5) * 2 * a;
      this._snapCurr[i * 3 + 1] = (0.5 - lm.y) * 2;
      this._snapCurr[i * 3 + 2] = -lm.z * 2 * a;
    }
    this._hasFace = true;
  }

  /** Consume a fresh detection result (arrives async from the worker). */
  ingest(result, tsMs) {
    if (result.faceLandmarks && result.faceLandmarks.length) {
      this.pushLandmarks(result.faceLandmarks[0], tsMs);
      this._updatePoseHUD(result, tsMs);
    }
    if (result.faceBlendshapes && result.faceBlendshapes.length) {
      this.setBlendshapes(result.faceBlendshapes[0]);
    }
  }

  /** Main per-frame update. result = fresh FaceLandmarker result or null. */
  update(result, nowMs) {
    if (result) this.ingest(result, nowMs);
    if (this.videoTex) this.videoTex.needsUpdate = true;
    this.videoPlane.scale.set(this.mirror ? -this.aspect : this.aspect, 1, 1);

    this.pose.tracking = this._hasFace;
    if (this._hasFace && !this._hadFace) this._smInitW = false; // fresh track: no lag
    this._hadFace = this._hasFace;

    // blendshape -> expression-transfer uniforms (smoothed)
    const dtMs = this._lastNow ? Math.min(100, nowMs - this._lastNow) : 16;
    this._lastNow = nowMs;
    if (this.maskMesh && this._lastBlendshapes) {
      const m = this._lastBlendshapes;
      const U = this.maskMesh.material.uniforms;
      const k = 1 - Math.exp(-dtMs / 70);
      U.uBlinkL.value += (smoothstep(0.15, 0.75, m.eyeBlinkLeft || 0) - U.uBlinkL.value) * k;
      U.uBlinkR.value += (smoothstep(0.15, 0.75, m.eyeBlinkRight || 0) - U.uBlinkR.value) * k;
      U.uJaw.value += (smoothstep(0.2, 0.85, m.jawOpen || 0) - U.uJaw.value) * k;
    }

    if (this.maskMesh) {
      this.maskMesh.visible = this._hasFace;
      this.maskMesh.material.uniforms.uOpacity.value = this.opacity;
      if (this._hasFace) this._updateMesh(nowMs);
    }
    this.dots.visible = this.debugDots && this._hasFace;
    if (this.dots.visible) this._updateDots(nowMs);
    this.renderer.render(this.scene, this.camera);
  }

  /* Interpolated sample one detection-interval in the past: perfectly smooth
   * glide at any detection Hz, at the cost of one interval of latency. */
  _interpAlpha(nowMs) {
    const interval = this._tCurr - this._tPrev;
    if (interval <= 0) return 1;
    const sampleT = nowMs - interval;
    return Math.max(0, Math.min(1, (sampleT - this._tPrev) / interval));
  }

  _fillInterp(nowMs) {
    const a = this._interpAlpha(nowMs);
    const b = 1 - a;
    const P = this._snapPrev, C = this._snapCurr, W = this._work;
    for (let i = 0; i < W.length; i++) W[i] = P[i] * b + C[i] * a;
    // one-euro-lite: exponential smoothing with speed-adaptive time constant —
    // kills jitter when still, stays responsive when the head moves.
    const S = this._smW;
    const dt = Math.min(100, Math.max(1, nowMs - (this._smLast || nowMs - 16)));
    this._smLast = nowMs;
    if (!this._smInitW) { S.set(W); this._smInitW = true; return S; }
    const o = 3; // nose vertex as speed proxy
    const speed = Math.hypot(W[o] - S[o], W[o + 1] - S[o + 1]) / (dt / 1000);
    const tau = speed > 1.2 ? 0.02 : speed > 0.4 ? 0.035 : 0.05;
    const al = 1 - Math.exp(-dt / 1000 / tau);
    for (let i = 0; i < W.length; i++) S[i] += (W[i] - S[i]) * al;
    return S;
  }

  _updateMesh(nowMs) {
    const W = this._fillInterp(nowMs);
    const geo = this.maskMesh.geometry;
    const pos = geo.getAttribute('position');
    const lmap = this.obj.landmarkIndexOfVertex;
    const n = this.obj.vertexCount;
    for (let i = 0; i < n; i++) {
      const o = lmap[i] * 3;
      pos.setXYZ(i, W[o], W[o + 1], W[o + 2] + 0.002);
    }
    if (this.expressionBoost) this._applyPuppet(pos);
    pos.needsUpdate = true;
  }

  /* Blendshape-driven micro-deformations on top of landmark positions:
   * extra blink squeeze, jaw drop, smile stretch. */
  _applyPuppet(pos) {
    const m = this._lastBlendshapes;
    if (!m) return;
    const blinkR = m.eyeBlinkRight || 0, blinkL = m.eyeBlinkLeft || 0;
    const jaw = m.jawOpen || 0, smile = Math.max(m.mouthSmileLeft || 0, m.mouthSmileRight || 0);
    if (blinkR + blinkL + jaw + smile < 0.05) return;

    const scaleRegionY = (verts, f) => {
      let cy = 0;
      for (let k = 0; k < verts.length; k++) cy += pos.getY(verts[k]);
      cy /= verts.length;
      for (let k = 0; k < verts.length; k++) {
        const vi = verts[k];
        pos.setY(vi, cy + (pos.getY(vi) - cy) * f);
      }
    };
    if (blinkR > 0.05) scaleRegionY(this._regions.eyeR, 1 - 0.55 * blinkR);
    if (blinkL > 0.05) scaleRegionY(this._regions.eyeL, 1 - 0.55 * blinkL);
    if (jaw > 0.05) {
      scaleRegionY(this._regions.mouth, 1 + 0.22 * jaw);
      const drop = 0.016 * jaw;
      const jv = this._regions.jaw;
      for (let k = 0; k < jv.length; k++) pos.setY(jv[k], pos.getY(jv[k]) - drop);
    }
    if (smile > 0.1) {
      const mv = this._regions.mouth;
      let cx = 0;
      for (let k = 0; k < mv.length; k++) cx += pos.getX(mv[k]);
      cx /= mv.length;
      const f = 1 + 0.12 * smile;
      for (let k = 0; k < mv.length; k++) {
        const vi = mv[k];
        pos.setX(vi, cx + (pos.getX(vi) - cx) * f);
      }
    }
  }

  setBlendshapes(bsArr) {
    if (!this._bsMap) this._bsMap = {};
    const m = this._bsMap;
    if (bsArr) for (const c of bsArr.categories) m[c.categoryName] = c.score;
    this._lastBlendshapes = m;
  }

  /* Face transformation matrix -> smoothed Euler angles for the HUD only. */
  _updatePoseHUD(result, dt) {
    const data = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0]
      ? result.facialTransformationMatrixes[0].data : null;
    if (!data) return;
    this._tmpM.fromArray(Array.from(data));
    this._tmpM.decompose(this._tmpV, this._tmpQ, this._tmpS);
    const k = Math.min(1, dt * 9);
    if (!this._smInit) {
      this._smPos.copy(this._tmpV); this._smQuat.copy(this._tmpQ); this._smScale.copy(this._tmpS);
      this._smInit = true;
    } else {
      this._smPos.lerp(this._tmpV, k);
      this._smQuat.slerp(this._tmpQ, k);
      this._smScale.lerp(this._tmpS, k);
    }
    this._euler.setFromQuaternion(this._smQuat, 'YXZ');
    this.pose.yaw = this._euler.y * 180 / Math.PI;
    this.pose.pitch = this._euler.x * 180 / Math.PI;
    this.pose.roll = this._euler.z * 180 / Math.PI;
    this.pose.dist = this._smScale.x || 1;
  }

  _updateDots(nowMs) {
    const W = this._fillInterp(nowMs);
    const pos = this.dots.geometry.getAttribute('position');
    for (let i = 0; i < 468; i++) {
      pos.setXYZ(i, W[i * 3], W[i * 3 + 1], W[i * 3 + 2] + 0.004);
    }
    pos.needsUpdate = true;
    this.dots.geometry.setDrawRange(0, 468);
  }

  renderOnce() { this.renderer.render(this.scene, this.camera); }
}
