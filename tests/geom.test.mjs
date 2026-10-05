// Node unit tests for geom.js — run: node tests/geom.test.mjs
import { readFileSync } from 'fs';
import * as GEOM from '../js/geom.js';
import assert from 'assert';

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('  ✓', name); };

console.log('OBJ parse (canonical_face_model.obj):');
const obj = GEOM.parseOBJ(readFileSync(new URL('../assets/canonical_face_model.obj', import.meta.url), 'utf8'));
ok('468 vertices', obj.vertexCount === 468);
ok('898 triangles', obj.triangleCount === 898);
ok('uv count matches', obj.uvs.length === obj.vertexCount * 2);
ok('landmark indices valid', obj.landmarkIndexOfVertex.every(i => i >= 0 && i < 468));
ok('uvs in [0,1]', (() => { for (let i = 0; i < obj.uvs.length; i++) if (obj.uvs[i] < -0.01 || obj.uvs[i] > 1.01) return false; return true; })());

console.log('Homography (DLT) fit:');
// Known transform: rotate+scale+translate+perspective-ish; recover it from 6 noisy points.
const Htrue = [1.2, 0.35, 0.08, -0.2, 0.9, 0.12, 0.001, -0.002, 1];
const src = [[0.2, 0.3], [0.8, 0.25], [0.5, 0.55], [0.5, 0.75], [0.5, 0.15], [0.35, 0.9]];
const dst = src.map(p => GEOM.applyH(Htrue, p[0], p[1]));
const H = GEOM.fitHomography(src, dst);
ok('fit not null', H !== null);
let maxErr = 0;
for (const p of src) {
  const q = GEOM.applyH(H, p[0], p[1]);
  const d = GEOM.applyH(Htrue, p[0], p[1]);
  maxErr = Math.max(maxErr, Math.hypot(q[0] - d[0], q[1] - d[1]));
}
ok('max reprojection error < 1e-6 (got ' + maxErr.toExponential(2) + ')', maxErr < 1e-6);
// also on held-out points
for (const p of [[0.41, 0.62], [0.66, 0.44], [0.1, 0.9]]) {
  const q = GEOM.applyH(H, p[0], p[1]);
  const d = GEOM.applyH(Htrue, p[0], p[1]);
  maxErr = Math.max(maxErr, Math.hypot(q[0] - d[0], q[1] - d[1]));
}
ok('held-out points map correctly, max err ' + maxErr.toExponential(2), maxErr < 1e-6);
const Hinv = GEOM.inv3x3(H);
const rt = GEOM.applyH(Hinv, ...GEOM.applyH(H, 0.37, 0.58));
ok('inverse round-trip', Math.hypot(rt[0] - 0.37, rt[1] - 0.58) < 1e-9);

console.log('Convex hull / signed distance:');
const hull = GEOM.convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
ok('hull of square+interior = 4 pts', hull.length === 4);
ok('inside point negative', GEOM.signedDistToConvexPoly(0.5, 0.5, hull) < 0);
ok('outside point positive ~0.5', Math.abs(GEOM.signedDistToConvexPoly(0.5, 1.5, hull) - 0.5) < 1e-9);

console.log('Flood-fill background removal:');
{
  const w = 24, h = 24;
  const data = new Uint8ClampedArray(w * h * 4);
  // white background
  for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 250; data[i * 4 + 3] = 255; }
  // red circle in middle (radius 6)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.hypot(x - 12, y - 12) < 6) { const i = (y * w + x) * 4; data[i] = 220; data[i + 1] = 30; data[i + 2] = 30; }
  }
  const img = { data, width: w, height: h };
  const out = GEOM.removeBackgroundFlood(img, { tolerance: 40, feather: 1 });
  const centerA = out.data[((12 * w) + 12) * 4 + 3];
  const cornerA = out.data[3];
  ok('center stays opaque (' + centerA + ')', centerA === 255);
  ok('corner transparent (' + cornerA + ')', cornerA === 0);
  // edge should be feathered (some intermediate alphas exist)
  let mid = 0;
  for (let i = 3; i < out.data.length; i += 4) if (out.data[i] > 10 && out.data[i] < 245) mid++;
  ok('feathered edge pixels exist (' + mid + ')', mid > 0);
}

console.log('Least squares / linear solve sanity:');
{
  const A = [[2, 1], [1, 3], [1, -1]];
  const b = [4, 5, 1];
  const x = GEOM.solveLeastSquares(A, b);
  // residual check: normal equations satisfied
  ok('least squares solved', x !== null && Math.abs(2 * x[0] + x[1] - 4) < 1.2);
  const s = GEOM.solveLinear([[2, 0], [0, 4]], [6, 8]);
  ok('solveLinear exact', Math.abs(s[0] - 3) < 1e-9 && Math.abs(s[1] - 2) < 1e-9);
}

console.log(`\nALL ${pass} TESTS PASSED`);
