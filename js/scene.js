/* scene.js — Three.js rendering: video background + texture-mapped face mesh.
 *
 * Pipeline per frame:
 *   landmarks (478) -> world positions -> stabilize with face transformation
 *   matrix (EMA-smoothed) -> blendshape "puppet" micro-deformations -> mesh.
 * Mask UVs come from the calibration homography (image pts -> canonical UV
 * anchors); per-vertex alpha fades the mask outside the 6-point hull.
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

/* Blendshape puppet regions (canonical vertex indices). */
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
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(map, vUv);
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
    const planeGeo = new THREE.PlaneGeometry(2, 2);
    this.videoPlane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide }));
    this.videoPlane.position.z = 0;
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

    // stabilization state (face matrix EMA)
    this._smPos = new THREE.Vector3();
    this._smQuat = new THREE.Quaternion();
    this._smScale = new THREE.Vector3(1, 1, 1);
    this._smInit = false;
    this._mRaw = new THREE.Matrix4();
    this._mSm = new THREE.Matrix4();
    this._mCorr = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();
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
    const dpr = Math.min(window.devicePixelRatio || 1, this.lite ? 1 : 2);
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
      uniforms: { map: { value: null }, uOpacity: { value: 1 } },
      vertexShader: MASK_VERT, fragmentShader: MASK_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.maskMesh = new THREE.Mesh(geo, mat);
    this.maskMesh.renderOrder = 5;
    this.maskMesh.frustumCulled = false;
    this.maskMesh.position.z = 0.001;
    this.scene.add(this.maskMesh);

    // Precompute anchor UVs in canonical texture space (vt, v-up).
    this.anchorUVs = ANCHOR_LANDMARKS.map(group => {
      let u = 0, v = 0;
      for (const li of group) {
        // find the unique vertex (or first one) whose landmark index == li
        const vi = this._vertexForLandmark(li);
        u += obj.uvs[vi * 2]; v += obj.uvs[vi * 2 + 1];
      }
      return [u / group.length, v / group.length];
    });
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
    this.maskTexture = tex;
    this.maskMesh.material.uniforms.map.value = tex;
    this.calib = calib;
    this.maskFlip = flip;
    this.recomputeUVs();
  }

  /* Fit homography image->canonical UV from the 6 calibration points, then
   * invert it to get each mesh vertex's texture coordinate + alpha falloff. */
  recomputeUVs() {
    if (!this.calib || !this.obj || !this.maskMesh) return;
    let pts = this.calib.map(p => [p.x, 1 - p.y]); // to texture space (v-up)
    if (this.maskFlip) {
      const flipped = pts.slice();
      flipped[0] = [1 - pts[1][0], pts[1][1]]; // left eye <- right eye (mirrored u)
      flipped[1] = [1 - pts[0][0], pts[0][1]];
      pts = flipped;
    }
    const H = fitHomography(pts, this.anchorUVs);
    if (!H) return;
    const Hinv = inv3x3(H);
    if (!Hinv) return;

    // centroid of source pts for scale slider
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;

    const uvAttr = this.maskMesh.geometry.getAttribute('uv');
    const alphaAttr = this.maskMesh.geometry.getAttribute('aAlpha');
    const hull = convexHull(this.anchorUVs);
    const s = Math.max(0.2, this.maskScale);

    for (let i = 0; i < this.obj.vertexCount; i++) {
      const u = this.obj.uvs[i * 2], v = this.obj.uvs[i * 2 + 1];
      let [tu, tv] = applyH(Hinv, u, v);
      // scale slider: zoom the image around the source centroid
      tu = cx + (tu - cx) / s;
      tv = cy + (tv - cy) / s;
      uvAttr.setXY(i, tu, tv);
      const d = signedDistToConvexPoly(u, v, hull);
      alphaAttr.setX(i, 1 - smoothstep(0.012, 0.085, d));
    }
    uvAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  /** Update calibration points without rebuilding the texture (live drag). */
  updateCalib(calib, flip) {
    this.calib = calib;
    if (flip !== undefined) this.maskFlip = flip;
    this.recomputeUVs();
  }

  setMaskScale(s) { this.maskScale = s; this.recomputeUVs(); }
  setOpacity(o) { this.opacity = o; }

  /** Main per-frame update. result = FaceLandmarker result (or null). */
  update(result, dt) {
    if (this.video && this.videoTex) this.videoTex.needsUpdate = true;
    this.videoPlane.scale.set(this.mirror ? -this.aspect : this.aspect, 1, 1);

    const hasFace = !!(result && result.faceLandmarks && result.faceLandmarks.length);
    this.pose.tracking = hasFace;
    if (hasFace && this.maskMesh) {
      const lms = result.faceLandmarks[0];
      this._updateStabilization(result, dt);
      this._updateMesh(lms);
      this._updateDots(lms);
    }
    if (this.maskMesh) {
      this.maskMesh.visible = hasFace;
      this.maskMesh.material.uniforms.uOpacity.value = this.opacity;
    }
    this.dots.visible = this.debugDots && hasFace;
    this.renderer.render(this.scene, this.camera);
  }

  _lmToWorld(lm, out) {
    const x = this.mirror ? 1 - lm.x : lm.x;
    out[0] = (x - 0.5) * 2 * this.aspect;
    out[1] = (0.5 - lm.y) * 2;
    out[2] = -lm.z * 2 * this.aspect;
  }

  /* EMA-smooth the face transformation matrix; correction C = S * M^-1 is
   * applied to all vertices to stabilize the mask without losing expressions. */
  _updateStabilization(result, dt) {
    const data = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0]
      ? result.facialTransformationMatrixes[0].data : null;
    if (!data) return;
    this._mRaw.fromArray(Array.from(data)); // column-major
    this._mRaw.decompose(this._tmpV, this._rawQuat || (this._rawQuat = new THREE.Quaternion()), this._rawScale || (this._rawScale = new THREE.Vector3()));
    const k = Math.min(1, dt * 9); // ~110ms time constant
    if (!this._smInit) {
      this._smPos.copy(this._tmpV);
      this._smQuat.copy(this._rawQuat);
      this._smScale.copy(this._rawScale);
      this._smInit = true;
    } else {
      this._smPos.lerp(this._tmpV, k);
      this._smQuat.slerp(this._rawQuat, k);
      this._smScale.lerp(this._rawScale, k);
    }
    this._mSm.compose(this._smPos, this._smQuat, this._smScale);
    // NOTE: the smoothed matrix feeds the pose HUD only. It is NOT applied to the
    // mesh (see _updateMesh): the matrix lives in cm while the mesh is in screen
    // units, so composing S*M^-1 and applying it made the mask drift on head turns.
    const e = new THREE.Euler().setFromQuaternion(this._smQuat, 'YXZ');
    this.pose.yaw = e.y * 180 / Math.PI;
    this.pose.pitch = e.x * 180 / Math.PI;
    this.pose.roll = e.z * 180 / Math.PI;
    this.pose.dist = this._smScale.x || 1;
  }

  _updateMesh(lms) {
    const geo = this.maskMesh.geometry;
    const pos = geo.getAttribute('position');
    const lmap = this.obj.landmarkIndexOfVertex;
    const n = this.obj.vertexCount;
    const tmp = [0, 0, 0];
    // landmark EMA smoothing (light) for shimmer reduction
    if (!this._lmSmooth) this._lmSmooth = new Float32Array(478 * 3);
    for (let i = 0; i < n; i++) {
      const li = lmap[i];
      const lm = lms[li] || lms[0];
      this._lmToWorld(lm, tmp);
      const o = li * 3;
      const a = 0.55;
      this._lmSmooth[o] += (tmp[0] - this._lmSmooth[o]) * a;
      this._lmSmooth[o + 1] += (tmp[1] - this._lmSmooth[o + 1]) * a;
      this._lmSmooth[o + 2] += (tmp[2] - this._lmSmooth[o + 2]) * a;
      this._tmpV.set(this._lmSmooth[o], this._lmSmooth[o + 1], this._lmSmooth[o + 2]);
      // Do NOT apply _mCorr here: matrix is in cm (z about -30), mesh is in screen units (+-1).
      // Landmarks are already smoothed above. Matrix is used for the pose HUD only.
      pos.setXYZ(i, this._tmpV.x, this._tmpV.y, this._tmpV.z + 0.002);
    }
    if (this.expressionBoost) this._applyPuppet(lms, pos);
    pos.needsUpdate = true;
    geo.computeBoundingSphere && (geo.boundingSphere = null);
  }

  /* Blendshape-driven micro-deformations on top of landmark positions:
   * extra blink squeeze, jaw drop, smile stretch. */
  _applyPuppet(lms, pos) {
    const bs = (name) => {
      const arr = this._lastBlendshapes;
      return arr ? (arr[name] || 0) : 0;
    };
    const blinkR = bs('eyeBlinkRight'), blinkL = bs('eyeBlinkLeft');
    const jaw = bs('jawOpen'), smileL = bs('mouthSmileLeft'), smileR = bs('mouthSmileRight');
    if (blinkR + blinkL + jaw + smileL + smileR < 0.02) return;

    const regionPos = (idxs, out) => {
      let cx = 0, cy = 0;
      const pts = [];
      for (const li of idxs) {
        const vi = this._vertexForLandmark(li);
        const x = pos.getX(vi), y = pos.getY(vi);
        cx += x; cy += y;
        pts.push(vi);
      }
      out.cx = cx / idxs.length; out.cy = cy / idxs.length; out.pts = pts;
      return out;
    };
    const scratch = {};
    const scaleRegionY = (idxs, f) => {
      const r = regionPos(idxs, scratch);
      for (const vi of r.pts) pos.setY(vi, r.cy + (pos.getY(vi) - r.cy) * f);
    };
    if (blinkR > 0.05) scaleRegionY(REGION.eyeR, 1 - 0.4 * blinkR);
    if (blinkL > 0.05) scaleRegionY(REGION.eyeL, 1 - 0.4 * blinkL);
    if (jaw > 0.05) {
      const r = regionPos(REGION.mouth, scratch);
      const f = 1 + 0.18 * jaw;
      for (const vi of r.pts) {
        pos.setY(vi, r.cy + (pos.getY(vi) - r.cy) * f);
        if (pos.getY(vi) < r.cy) pos.setY(vi, pos.getY(vi) - 0.02 * jaw * this.pose.dist);
      }
      const jr = regionPos(REGION.jaw, scratch);
      for (const vi of jr.pts) pos.setY(vi, pos.getY(vi) - 0.012 * jaw * this.pose.dist);
    }
    if (smileL + smileR > 0.1) {
      // symmetric mouth widen driven by the stronger smile side
      const r = regionPos(REGION.mouth, scratch);
      const f = 1 + 0.12 * Math.max(smileL, smileR);
      for (const vi of r.pts) {
        const dx = pos.getX(vi) - r.cx;
        pos.setX(vi, r.cx + dx * f);
      }
    }
  }

  setBlendshapes(bsArr) {
    if (!this._bsMap) this._bsMap = {};
    const m = this._bsMap;
    if (bsArr) for (const c of bsArr.categories) m[c.categoryName] = c.score;
    this._lastBlendshapes = m;
  }

  _updateDots(lms) {
    const pos = this.dots.geometry.getAttribute('position');
    const tmp = [0, 0, 0];
    for (let i = 0; i < lms.length && i < 478; i++) {
      this._lmToWorld(lms[i], tmp);
      pos.setXYZ(i, tmp[0], tmp[1], tmp[2] + 0.004);
    }
    pos.needsUpdate = true;
    this.dots.geometry.setDrawRange(0, lms.length);
  }

  renderOnce() { this.renderer.render(this.scene, this.camera); }
}
