#!/usr/bin/env python3
"""Drift regression test for Fix 1: with a head turn in the video, the mask
mesh centroid must stay glued to the landmark centroid (drift < 0.15 world
units). Pre-fix code (applying the cm-space face-matrix correction to the
screen-unit mesh) moves the mask several screen heights here."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Y4M = os.path.join(BASE, 'tests', 'turn.y4m')
# BUG=1: serve scene.js with the OLD drift bug re-inserted AND the EMA constant
# lowered (dt*0.9) to emulate the rotation lag a real 30 fps phone sees (headless
# CI runs ~3 fps where k=min(1,dt*9) saturates and hides the bug). Used as a
# negative control: the test must FAIL in this mode.
BUG = os.environ.get('BUG') == '1'

OFFSET_FN = '''() => {
  const s = window.__fmc.scene;
  if (!s.maskMesh || !s.maskMesh.visible) return null;
  const pos = s.maskMesh.geometry.getAttribute('position');
  const dots = s.dots.geometry.getAttribute('position');
  let mx = 0, my = 0;
  for (let i = 0; i < pos.count; i++) { mx += pos.getX(i); my += pos.getY(i); }
  mx /= pos.count; my /= pos.count;
  let dx = 0, dy = 0;
  for (let i = 0; i < dots.count; i++) { dx += dots.getX(i); dy += dots.getY(i); }
  dx /= dots.count; dy /= dots.count;
  return Math.hypot(mx - dx, my - dy);
}'''

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            '--no-sandbox', '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-video-capture={Y4M}',
            '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'])
        ctx = browser.new_context(viewport={'width': 900, 'height': 1100},
                                  permissions=['camera'])
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        if BUG:
            src = open(os.path.join(BASE, 'js', 'scene.js')).read()
            src = src.replace(
                "      // Do NOT apply _mCorr here: matrix is in cm (z about -30), mesh is in screen units (+-1).\n"
                "      // Landmarks are already smoothed above. Matrix is used for the pose HUD only.\n"
                "      pos.setXYZ",
                "      this._tmpV.applyMatrix4(this._mCorr);\n      pos.setXYZ")
            src = src.replace(
                "    // NOTE: the smoothed matrix feeds the pose HUD only. It is NOT applied to the\n"
                "    // mesh (see _updateMesh): the matrix lives in cm while the mesh is in screen\n"
                "    // units, so composing S*M^-1 and applying it made the mask drift on head turns.\n"
                "    const e",
                "    const inv = this._mInv || (this._mInv = new THREE.Matrix4());\n"
                "    inv.copy(this._mRaw).invert();\n"
                "    this._mCorr.copy(this._mSm).multiply(inv);\n    const e")
            src = src.replace("dt * 9", "dt * 0.9")
            page.route('**/js/scene.js', lambda route: route.fulfill(body=src, content_type='text/javascript'))
        page.goto('http://127.0.0.1:8000/', wait_until='domcontentloaded')
        page.click('#btn-start')
        page.wait_for_selector('#hud:not([hidden])', timeout=120_000)
        page.wait_for_function('window.__fmc.scene.pose.tracking === true', timeout=60_000)

        # sample mask-vs-landmark centroid offset across several loop cycles,
        # covering the frontal->turned transition both ways
        import time
        samples = []
        t0 = time.time()
        while time.time() - t0 < 8:
            v = page.evaluate(OFFSET_FN)
            if v is not None:
                samples.append(v)
            page.wait_for_timeout(120)
        browser.close()

    if not samples:
        print('FAIL: no samples (mask never visible)')
        sys.exit(1)
    drift = max(samples) - min(samples)
    print(f'samples={len(samples)} min={min(samples):.4f} max={max(samples):.4f} drift={drift:.4f}')
    if errs:
        print('pageerrors:', errs[:3])
        sys.exit(1)
    if drift < 0.15:
        print('DRIFT TEST PASSED — mask stays on the face through the head turn')
    else:
        print('DRIFT TEST FAILED — mask moved away from the face')
        sys.exit(1)

if __name__ == '__main__':
    main()
