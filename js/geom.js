/* geom.js — pure math core (no DOM, no THREE). Works in browser + Node (for tests).
 * - OBJ parser for the MediaPipe canonical face model (468 verts, v/vt faces)
 * - Projective homography fit (DLT) used by the 6-point calibration
 * - Convex hull + signed distance for per-vertex alpha falloff
 * - Flood-fill background removal for uploaded mask art
 */
'use strict';

// Node tests construct ImageData manually; browsers use the native one.
const ImageDataCtor = (typeof ImageData !== 'undefined')
  ? ImageData
  : class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };

  /* ---------------------------------- OBJ ---------------------------------- */
  // Parses canonical_face_model.obj: "v x y z", "vt u v", "f v/vt v/vt v/vt".
  // UV seams could split vertices, so we key unique "v/vt" pairs.
  function parseOBJ(text) {
    const positions = [];           // canonical (metric) positions, per unique vertex
    const uvs = [];
    const indices = [];
    const landmarkIndexOfVertex = []; // unique-vertex -> landmark index (0-based)
    const vList = [], vtList = [];
    const pairMap = new Map();      // "v/vt" -> unique index

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      const tag = parts[0];
      if (tag === 'v') {
        vList.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
      } else if (tag === 'vt') {
        vtList.push([parseFloat(parts[1]), parseFloat(parts[2])]);
      } else if (tag === 'f') {
        const tri = [];
        for (let k = 1; k <= 3; k++) {
          const seg = parts[k].split('/');
          const vi = parseInt(seg[0], 10) - 1;
          const ti = seg.length > 1 && seg[1] !== '' ? parseInt(seg[1], 10) - 1 : vi;
          const key = vi + '/' + ti;
          let uid = pairMap.get(key);
          if (uid === undefined) {
            uid = positions.length / 3;
            pairMap.set(key, uid);
            const p = vList[vi], t = vtList[ti] || [0, 0];
            positions.push(p[0], p[1], p[2]);
            uvs.push(t[0], t[1]);
            landmarkIndexOfVertex.push(vi);
          }
          tri.push(uid);
        }
        indices.push(tri[0], tri[1], tri[2]);
      }
    }
    return {
      positions: new Float32Array(positions),
      uvs: new Float32Array(uvs),
      indices: new Uint16Array(indices),
      landmarkIndexOfVertex: new Uint16Array(landmarkIndexOfVertex),
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    };
  }

  /* ------------------------------- Linear algebra -------------------------- */
  // Solve A x = b (n x n) via Gaussian elimination with partial pivoting.
  function solveLinear(A, b) {
    const n = b.length;
    const M = [];
    for (let i = 0; i < n; i++) M.push(A[i].slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-14) return null; // singular
      const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      const d = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = M[i][n];
    return x;
  }

  // Least squares solve of over-determined A x = b via normal equations (A^T A) x = A^T b.
  function solveLeastSquares(A, b) {
    const m = A.length, n = A[0].length;
    const ATA = [];
    const ATb = new Array(n).fill(0);
    for (let i = 0; i < n; i++) ATA.push(new Array(n).fill(0));
    for (let r = 0; r < m; r++) {
      for (let i = 0; i < n; i++) {
        ATb[i] += A[r][i] * b[r];
        for (let j = 0; j < n; j++) ATA[i][j] += A[r][i] * A[r][j];
      }
    }
    return solveLinear(ATA, ATb);
  }

  /* -------------------------------- Homography ------------------------------ */
  // Fit projective transform H (3x3, row-major Float64Array(9)) mapping src pts -> dst pts.
  // Least-squares DLT with Hartley normalization; h33 fixed to 1. Needs >= 4 pairs.
  function fitHomography(src, dst) {
    const n = src.length;
    if (n < 4 || n !== dst.length) throw new Error('fitHomography needs >= 4 pairs');

    function norm(pts) {
      let cx = 0, cy = 0;
      for (const p of pts) { cx += p[0]; cy += p[1]; }
      cx /= n; cy /= n;
      let d = 0;
      for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy);
      d /= n;
      const s = d > 1e-9 ? Math.SQRT2 / d : 1;
      return {
        T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
        apply: (p) => [s * (p[0] - cx), s * (p[1] - cy)],
      };
    }
    const Ns = norm(src), Nd = norm(dst);
    const A = [], b = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = Ns.apply(src[i]);
      const [xp, yp] = Nd.apply(dst[i]);
      A.push([x, y, 1, 0, 0, 0, -x * xp, -y * xp]); b.push(xp);
      A.push([0, 0, 0, x, y, 1, -x * yp, -y * yp]); b.push(yp);
    }
    const h = solveLeastSquares(A, b);
    if (!h) return null;
    const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    // Denormalize: H = Td^-1 * Hn * Ts
    const TdInv = inv3x3(Nd.T);
    return mat3mul(mat3mul(TdInv, Hn), Ns.T);
  }

  function mat3mul(A, B) {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
  }

  function inv3x3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const id = 1 / det;
    return [
      A * id, (c * h - b * i) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, (c * d - a * f) * id,
      C * id, (b * g - a * h) * id, (a * e - b * d) * id,
    ];
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < 1e-12) return [0, 0];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  /* ----------------------------- Convex hull etc. --------------------------- */
  // Monotone chain convex hull, CCW order. pts: array of [x, y].
  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  // Signed distance from point to convex polygon (CCW): negative inside.
  function signedDistToConvexPoly(px, py, hull) {
    let inside = true, minD = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const cross = ex * (py - a[1]) - ey * (px - a[0]);
      if (cross < 0) inside = false;
      const len2 = ex * ex + ey * ey || 1e-12;
      let t = ((px - a[0]) * ex + (py - a[1]) * ey) / len2;
      t = Math.max(0, Math.min(1, t));
      const dx = px - (a[0] + t * ex), dy = py - (a[1] + t * ey);
      minD = Math.min(minD, Math.hypot(dx, dy));
    }
    return inside ? -minD : minD;
  }

  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /* --------------------------- Background removal --------------------------- */
  // Region-growing flood fill from the image border: pixels color-similar to their
  // background neighbours become transparent, then the alpha edge is feathered.
  // Works offline; best on plain-background art. Returns a new ImageData.
  function removeBackgroundFlood(imageData, opts = {}) {
    const tol = opts.tolerance ?? 42;         // per-channel-ish color distance
    const feather = opts.feather ?? 1.4;      // blur radius-ish passes
    const { data, width: w, height: h } = imageData;
    const n = w * h;
    const isBG = new Uint8Array(n);
    const q = new Int32Array(n);
    let qh = 0, qt = 0;
    const tol2 = tol * tol * 3;

    // Average border color (the "background color" reference).
    let br = 0, bg = 0, bb = 0, cnt = 0;
    const borderIdx = [];
    for (let x = 0; x < w; x++) { borderIdx.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { borderIdx.push(y * w, y * w + w - 1); }
    for (const i of borderIdx) { br += data[i * 4]; bg += data[i * 4 + 1]; bb += data[i * 4 + 2]; cnt++; }
    br /= cnt; bg /= cnt; bb /= cnt;

    const closeToBG = (i, k) => {
      const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb;
      return dr * dr + dg * dg + db * db <= k;
    };

    // Global-tolerance flood: a pixel becomes background only if it is
    // connected to the border AND stays close to the border's average color.
    // (A neighbor-to-neighbor random walk would creep through soft AA
    // gradients and eat artwork; the global reference cannot.)
    for (const i of borderIdx) {
      if (closeToBG(i, tol2 * 2.25)) { isBG[i] = 1; q[qt++] = i; }
    }
    while (qh < qt) {
      const i = q[qh++];
      const x = i % w, y = (i / w) | 0;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (isBG[j]) continue;
        if (closeToBG(j, tol2)) { isBG[j] = 1; q[qt++] = j; }
      }
    }

    // Build alpha channel then feather (box blur on alpha)
    let alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) alpha[i] = isBG[i] ? 0 : 1;
    const passes = Math.max(1, Math.round(feather));
    for (let p = 0; p < passes; p++) alpha = boxBlur1D(alpha, w, h);

    const out = new Uint8ClampedArray(data); // copy
    for (let i = 0; i < n; i++) out[i * 4 + 3] = Math.round(data[i * 4 + 3] * alpha[i]);
    // Simple despill: multiply rgb by alpha at edges so halos fade (premultiplied-ish cleanup)
    return new ImageDataCtor(out, w, h);
  }

  function boxBlur1D(a, w, h) {
    const tmp = new Float32Array(a.length);
    const r = 1;
    // horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          s += a[y * w + xx]; c++;
        }
        tmp[y * w + x] = s / c;
      }
    }
    // vertical
    const out = new Float32Array(a.length);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          s += tmp[yy * w + x]; c++;
        }
        out[y * w + x] = s / c;
      }
    }
    return out;
  }

export {
  parseOBJ, solveLinear, solveLeastSquares,
  fitHomography, applyH, inv3x3, mat3mul,
  convexHull, signedDistToConvexPoly, smoothstep,
  removeBackgroundFlood,
};
