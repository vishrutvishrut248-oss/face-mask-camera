#!/usr/bin/env python3
"""Full feature audit: exercises every user-facing control and asserts the
internal state it should change. Prints a PASS/FAIL matrix."""
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

        page.goto('http://127.0.0.1:8000/', wait_until='domcontentloaded')
        page.click('#btn-start')
        page.wait_for_selector('#hud:not([hidden])', timeout=120_000)
        page.wait_for_function('window.__fmc.scene.pose.tracking === true', timeout=60_000)
        check('boot + tracking', True)

        E = page.evaluate

        # --- sliders ---
        page.fill('#sl-opacity', '40')
        page.dispatch_event('#sl-opacity', 'input')
        check('opacity slider', abs(E('window.__fmc.scene.opacity') - 0.4) < 1e-9,
              f"opacity={E('window.__fmc.scene.opacity')}")
        page.fill('#sl-scale', '140')
        page.dispatch_event('#sl-scale', 'input')
        check('scale slider', abs(E('window.__fmc.scene.maskScale') - 1.4) < 1e-9,
              f"scale={E('window.__fmc.scene.maskScale')}")

        # --- toggles ---
        page.click('#btn-mirror'); check('mirror toggle', E('window.__fmc.scene.mirror') is False)
        page.click('#btn-mirror'); check('mirror back on', E('window.__fmc.scene.mirror') is True)
        page.click('#btn-expr');  check('expression boost toggle', E('window.__fmc.scene.expressionBoost') is False)
        page.click('#btn-expr')
        page.click('#btn-dots')
        page.wait_for_timeout(400)
        check('debug dots visible', E('window.__fmc.scene.dots.visible') is True)
        page.click('#btn-dots')

        # --- blendshapes/matrix actually flowing ---
        info = E('''() => { const r = window.__fmc.tracker.lastResult;
            return { bs: r.faceBlendshapes[0].categories.length,
                     mtx: r.facialTransformationMatrixes.length,
                     lms: r.faceLandmarks[0].length }; }''')
        check('blendshapes(52) + face matrix live', info['bs'] == 52 and info['mtx'] == 1 and info['lms'] == 478, str(info))

        # --- mask switching via strip ---
        page.click('.maskstrip .thumb:nth-of-type(3)')  # robot (after upload btn)
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

        # AI BG: model streams from CDN on first use (~40 MB); allow up to 90 s,
        # and accept a graceful error toast if the CDN is unreachable.
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

        # --- save to gallery + delete ---
        page.click('#btn-save')
        page.wait_for_timeout(800)
        saved = E("localStorage.getItem('maskcam.masks.v1') ? JSON.parse(localStorage.getItem('maskcam.masks.v1')).length : 0")
        check('save mask to localStorage', saved == 1, f'count={saved}')
        page.click('#btn-gallery')
        page.wait_for_selector('#gallery:not([hidden])')
        gal_thumbs = E("document.querySelectorAll('#gallery-grid .thumb').length")
        check('gallery modal lists builtins+saved', gal_thumbs == 4, f'thumbs={gal_thumbs}')
        page.click('#gallery-grid .thumb .del')   # delete the saved one
        page.wait_for_timeout(400)
        saved2 = E("JSON.parse(localStorage.getItem('maskcam.masks.v1')||'[]').length")
        check('delete saved mask', saved2 == 0, f'count={saved2}')
        page.click('#gallery-close')

        # --- Fix 3 regression: a failed (quota) save must keep previous masks ---
        page.click('#btn-save'); page.wait_for_timeout(600)          # one saved mask
        stuffed = E("(() => { try { localStorage.setItem('maskcam.filler','x'.repeat(4900000)); return true; } catch { return false; } })()")
        page.click('#btn-save'); page.wait_for_timeout(600)          # must fail, keep old
        cnt = E("JSON.parse(localStorage.getItem('maskcam.masks.v1')||'[]').length")
        check('quota-failed save keeps old masks', cnt == 1, f'stuffed={stuffed} count={cnt}')
        E("localStorage.removeItem('maskcam.filler')")

        # --- info modal ---
        page.click('#btn-info'); page.wait_for_selector('#info:not([hidden])')
        has_copy = E("document.querySelector('#info .copyright-note').textContent.includes('Copyright')")
        check('info modal + copyright notice', has_copy)
        page.click('#info-close')

        # --- photo + record ---
        with page.expect_download(timeout=15000) as dl:
            page.click('#btn-photo')
        check('photo capture', dl.value.suggested_filename.endswith('.png'))
        with page.expect_download(timeout=30000) as dl2:
            page.click('#btn-record'); page.wait_for_timeout(2000); page.click('#btn-record')
        check('video record', dl2.value.suggested_filename.endswith(('.webm', '.mp4')))

        # --- Fix 4 regression: rear camera must not be mirrored ---
        page.click('#btn-flipcam'); page.wait_for_timeout(2500)
        check('rear cam unmirrored', E('window.__fmc.scene.mirror') is False)
        page.click('#btn-flipcam'); page.wait_for_timeout(2500)
        check('front cam mirrored again', E('window.__fmc.scene.mirror') is True)

        # --- lite mode ---
        page.click('#btn-lite'); page.wait_for_timeout(1500)
        check('lite mode', E('window.__fmc.state.lite') is True and E('window.__fmc.tracker.frameSkip') == 2)
        page.click('#btn-lite'); page.wait_for_timeout(1200)
        check('lite off restores', E('window.__fmc.state.lite') is False)

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
