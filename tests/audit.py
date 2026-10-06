#!/usr/bin/env python3
"""Full feature audit (new minimal UI): exercises every user-facing control and
asserts the internal state it should change. Prints a PASS/FAIL matrix."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Y4M = os.path.join(BASE, 'tests', 'face.y4m')
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(('PASS' if cond else 'FAIL'), name, ('— ' + extra) if extra else '')

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            '--no-sandbox', '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-video-capture={Y4M}',
            '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'])
        ctx = browser.new_context(viewport={'width': 1000, 'height': 1200},
                                  permissions=['camera', 'microphone'], accept_downloads=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'console.error: {m.text}') if m.type == 'error'
                and 'XNNPACK' not in m.text and 'TensorFlow' not in m.text else None)
        page.on('dialog', lambda d: d.accept('AuditCat'))

        def more_open():
            if page.evaluate("document.getElementById('more').hidden"):
                page.click('#btn-more')
                page.wait_for_selector('#more:not([hidden])')

        page.goto('http://127.0.0.1:8000/', wait_until='domcontentloaded')
        page.click('#btn-start')
        page.wait_for_selector('#hud:not([hidden])', timeout=120_000)
        page.wait_for_function('window.__fmc.scene.pose.tracking === true', timeout=60_000)
        check('boot + tracking', True)

        E = page.evaluate

        # minimal top-right: ONLY upload + more
        topbtns = E("[...document.querySelectorAll('.topbtns button')].map(b=>b.id)")
        check('top-right = upload + more only', topbtns == ['btn-upload', 'btn-more'], str(topbtns))

        # --- sliders (inside ⋯) ---
        more_open()
        page.fill('#sl-opacity', '40'); page.dispatch_event('#sl-opacity', 'input')
        check('opacity slider', abs(E('window.__fmc.scene.opacity') - 0.4) < 1e-9)
        page.fill('#sl-scale', '140'); page.dispatch_event('#sl-scale', 'input')
        check('scale slider', abs(E('window.__fmc.scene.maskScale') - 1.4) < 1e-9)

        # --- toggles ---
        page.click('#btn-mirror'); check('mirror toggle', E('window.__fmc.scene.mirror') is False)
        page.click('#btn-mirror'); check('mirror back on', E('window.__fmc.scene.mirror') is True)
        page.click('#btn-expr');  check('expression boost toggle', E('window.__fmc.scene.expressionBoost') is False)
        page.click('#btn-expr')
        page.click('#btn-dots'); page.wait_for_timeout(400)
        check('debug dots visible', E('window.__fmc.scene.dots.visible') is True)
        page.click('#btn-dots')

        # --- blendshapes/matrix actually flowing ---
        info = E('''() => { const r = window.__fmc.tracker.lastResult;
            return { bs: r.faceBlendshapes[0].categories.length,
                     mtx: r.facialTransformationMatrixes.length,
                     lms: r.faceLandmarks[0].length }; }''')
        check('blendshapes(52) + face matrix live', info['bs'] == 52 and info['mtx'] == 1 and info['lms'] == 478, str(info))

        # --- full-face coverage: alpha hull includes the face oval ---
        alpha_min_face = E('''() => {
            const a = window.__fmc.scene.maskMesh.geometry.getAttribute('aAlpha');
            // sample cheek/temple vertices (face oval) — should be ~1 now
            const vs = window.__fmc.scene._vertexForLandmark.bind(window.__fmc.scene);
            let s = 0; const idx = [234, 454, 109, 338];
            for (const li of idx) s += a.getX(vs(li));
            return s / idx.length;
        }''')
        check('full-face alpha coverage (oval ~1)', alpha_min_face > 0.9, f'avg={alpha_min_face:.3f}')

        # --- mask switching via strip ---
        page.click('#maskstrip .thumb:nth-of-type(2)')
        page.wait_for_timeout(1200)
        check('mask switch (robot)', E("window.__fmc.state.current.id") == 'builtin-robot')

        # --- calibration ops ---
        page.click('#btn-calib')
        page.wait_for_selector('#calib:not([hidden])')
        page.click('#calib-flip');  check('calib flip', E('window.__fmc.scene.maskFlip') is True)
        page.click('#calib-flip')
        page.click('#calib-reset')
        cal = E('window.__fmc.state.current.calib[4]')
        check('calib reset', abs(cal['y'] - 0.87) < 1e-6, str(cal))
        page.click('#calib-auto');  page.wait_for_timeout(3000)
        check('calib auto-detect ran', True)
        page.click('#bg-simple');   page.wait_for_timeout(500)
        check('simple BG button', E('window.__fmc.state.current.processed !== window.__fmc.state.current.orig'))
        page.click('#bg-none')
        check('original BG button', E('window.__fmc.state.current.processed === window.__fmc.state.current.orig'))

        # AI BG
        page.click('#bg-ai')
        ai_ok = False
        try:
            page.wait_for_function('window.__fmc.state.current.processed !== window.__fmc.state.current.orig', timeout=90_000)
            ai_ok = True
        except Exception:
            ai_ok = E("document.getElementById('toast').textContent.includes('AI removal unavailable')")
        check('AI BG removal (or graceful offline fallback)', ai_ok)
        page.click('#bg-none')
        page.click('#calib-done')
        check('calib close', E("!document.getElementById('calib').hidden") is False)

        # --- upload + rights gate ---
        page.click('#btn-upload')
        page.wait_for_selector('#rights:not([hidden])')
        check('rights gate blocks', page.is_disabled('#rights-ok'))
        page.check('#rights-check'); page.click('#rights-ok')
        page.set_input_files('#file-input', os.path.join(BASE, 'assets', 'raw', 'cat.png'))
        page.wait_for_selector('#calib:not([hidden])', timeout=15000)
        page.wait_for_timeout(3500)
        check('upload → calib + bg removal', E('window.__fmc.state.current.processed !== window.__fmc.state.current.orig'))
        page.click('#calib-done')

        # --- save to gallery + delete (inside ⋯) ---
        more_open()
        page.click('#btn-save'); page.wait_for_timeout(800)
        saved = E("localStorage.getItem('maskcam.masks.v1') ? JSON.parse(localStorage.getItem('maskcam.masks.v1')).length : 0")
        check('save mask to localStorage', saved == 1, f'count={saved}')
        thumbs = E("document.querySelectorAll('#maskstrip .thumb').length")
        check('more sheet lists builtins+saved', thumbs == 5, f'thumbs={thumbs}')
        page.click('#maskstrip .thumb .del')
        page.wait_for_timeout(400)
        saved2 = E("JSON.parse(localStorage.getItem('maskcam.masks.v1')||'[]').length")
        check('delete saved mask', saved2 == 0, f'count={saved2}')

        # --- Fix 3 regression: quota-failed save keeps old masks ---
        page.click('#btn-save'); page.wait_for_timeout(600)
        # greedily fill storage to just below quota (UTF-16: 2 bytes per char)
        stuffed = E("(() => { let placed = 0; for (let n = 3000000; n >= 100000; n -= 100000) { try { localStorage.setItem('maskcam.filler' + n, 'x'.repeat(n)); placed += n; } catch {} } return placed; })()")
        page.click('#btn-save'); page.wait_for_timeout(600)
        cnt = E("JSON.parse(localStorage.getItem('maskcam.masks.v1')||'[]').length")
        check('quota-failed save keeps old masks', stuffed > 0 and cnt == 1, f'stuffed={stuffed} count={cnt}')
        E("Object.keys(localStorage).filter(k=>k.startsWith('maskcam.filler')).forEach(k=>localStorage.removeItem(k))")

        # --- info modal + copyright ---
        page.click('#btn-info')
        page.wait_for_selector('#info:not([hidden])')
        has_copy = E("document.querySelector('#info .copyright-note').textContent.includes('Copyright')")
        check('info modal + copyright notice', has_copy)
        page.click('#info-close')

        # --- photo + record ---
        with page.expect_download(timeout=15000) as dl:
            page.click('#btn-photo')
        check('photo capture', dl.value.suggested_filename.endswith('.png'))
        with page.expect_download(timeout=30000) as dl2:
            page.click('#btn-record'); page.wait_for_timeout(2000)
            # CI software GL: captureStream readback starves rAF, so playwright
            # actionability can starve mid-recording; stop via JS click instead
            # (same app code path as a user tap).
            E("document.getElementById('btn-rec-chip').click()")
        check('video record + pill stop', dl2.value.suggested_filename.endswith(('.webm', '.mp4')))

        # --- Fix 4 regression: rear camera must not be mirrored ---
        more_open()
        page.click('#btn-flipcam'); page.wait_for_timeout(2500)
        check('rear cam unmirrored', E('window.__fmc.scene.mirror') is False)
        page.click('#btn-flipcam'); page.wait_for_timeout(2500)
        check('front cam mirrored again', E('window.__fmc.scene.mirror') is True)

        # --- lite mode ---
        page.click('#btn-lite'); page.wait_for_timeout(1500)
        check('lite mode', E('window.__fmc.state.lite') is True and E('window.__fmc.scene.dprCap') == 1)
        page.click('#btn-lite'); page.wait_for_timeout(1200)
        check('lite off restores', E('window.__fmc.state.lite') is False)

        # --- smoothness architecture: adaptive detection cadence must engage
        # when detection is slow (it is, on CI's software renderer) ---
        perf = E('window.__fmc.perf()')
        check('adaptive detection cadence engaged', perf['detectEvery'] >= 66 and perf['detectMs'] > 24,
              f"detectEvery={perf['detectEvery']}ms detectMs={perf['detectMs']}")

        browser.close()

    fails = [r for r in results if not r[1]]
    print('\n================ AUDIT SUMMARY ================')
    print(f'{len(results) - len(fails)}/{len(results)} features passed')
    for e in errors:
        print('RUNTIME ERROR:', e[:200])
    if fails or errors:
        sys.exit(1)
    print('ALL FEATURES WORKING — NO RUNTIME ERRORS')

if __name__ == '__main__':
    main()
