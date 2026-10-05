#!/usr/bin/env python3
"""Headless end-to-end smoke test: serves the site, feeds Chromium a fake
webcam (Y4M with a real face), and walks the full user flow."""
import os, sys, time, json
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Y4M = os.path.join(BASE, 'tests', 'face.y4m')
SHOTS = os.path.join(BASE, 'tests', 'shots')
os.makedirs(SHOTS, exist_ok=True)
errors, warnings = [], []

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--no-sandbox',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                f'--use-file-for-fake-video-capture={Y4M}',
                '--autoplay-policy=no-user-gesture-required',
                '--enable-unsafe-swiftshader',
            ],
        )
        ctx = browser.new_context(
            viewport={'width': 900, 'height': 1200},
            permissions=['camera', 'microphone'],
            accept_downloads=True,
        )
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: (
            errors.append(f'console.error: {m.text}') if m.type == 'error'
            else warnings.append(f'console.{m.type}: {m.text}') if m.type == 'warning' else None
        ))

        page.goto('http://127.0.0.1:8000/', wait_until='domcontentloaded')
        print('[1] page loaded')

        page.click('#btn-start')
        page.wait_for_selector('#hud:not([hidden])', timeout=120_000)
        print('[2] HUD visible (camera + model + mesh boot OK)')

        # wait for face tracking on the fake video
        page.wait_for_function('window.__fmc && window.__fmc.scene.pose.tracking === true', timeout=60_000)
        print('[3] face tracked (blendshapes + face matrix pipeline live)')

        # let the mask render a few frames
        page.wait_for_timeout(2500)
        fps = page.text_content('#chip-fps')
        pose = page.text_content('#chip-pose')
        print(f'[4] chips: fps="{fps}" pose="{pose}"')
        page.screenshot(path=os.path.join(SHOTS, '1-live-mask.png'))

        # mask actually applied?
        has_mask = page.evaluate('!!(window.__fmc.state.current && window.__fmc.scene.maskTexture)')
        print('[5] mask applied:', has_mask)
        assert has_mask, 'mask texture not set'

        # blendshape + matrix availability from last result
        info = page.evaluate('''() => {
            const t = window.__fmc.tracker;
            const r = t.lastResult;
            return {
              lms: r && r.faceLandmarks ? r.faceLandmarks[0].length : 0,
              bs: r && r.faceBlendshapes && r.faceBlendshapes[0] ? r.faceBlendshapes[0].categories.length : 0,
              mtx: r && r.facialTransformationMatrixes ? r.facialTransformationMatrixes.length : 0,
            };
        }''')
        print('[6] landmarker outputs:', json.dumps(info))
        assert info['lms'] == 478 and info['bs'] >= 50 and info['mtx'] == 1

        # calibration panel opens with 6 draggable points
        page.click('#btn-calib')
        page.wait_for_selector('#calib:not([hidden])', timeout=5000)
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(SHOTS, '2-calibration.png'))
        print('[7] calibration panel open')

        # drag point 4 (chin) to a new spot via pointer events
        before = page.evaluate('JSON.parse(JSON.stringify(window.__fmc.state.current.calib[4]))')
        box = page.locator('#calib-canvas').bounding_box()
        px, py = box['x'] + before['x'] * box['width'], box['y'] + before['y'] * box['height']
        page.mouse.move(px, py)
        page.mouse.down()
        page.mouse.move(px, py + 20, steps=4)
        page.mouse.up()
        after = page.evaluate('window.__fmc.state.current.calib[4]')
        print(f'[8] drag chin point: before={before} after={after}')
        assert abs(after['y'] - before['y']) > 0.001, 'drag did not move point'

        # close calib, run upload flow with copyright gate
        page.click('#calib-close')
        page.click('#btn-upload')
        page.wait_for_selector('#rights:not([hidden])', timeout=5000)
        ok_disabled = page.is_disabled('#rights-ok')
        print('[9] rights gate shown, continue disabled until consent:', ok_disabled)
        assert ok_disabled
        page.check('#rights-check')
        assert not page.is_disabled('#rights-ok')
        page.click('#rights-ok')
        page.set_input_files('#file-input', os.path.join(BASE, 'assets', 'raw', 'cat.png'))
        page.wait_for_selector('#calib:not([hidden])', timeout=15000)
        print('[10] upload ingested, calibration reopened for the cat art')
        page.wait_for_timeout(4000)   # async auto-calibrate
        page.screenshot(path=os.path.join(SHOTS, '3-upload-calib.png'))

        # switch mask from gallery via strip (robot thumb = 2nd builtin)
        page.click('#calib-done')
        page.wait_for_timeout(300)

        # photo capture (download event)
        with page.expect_download(timeout=15000) as dl:
            page.click('#btn-photo')
        photo = dl.value
        photo.save_as(os.path.join(SHOTS, '4-photo.png'))
        print('[11] photo captured:', photo.suggested_filename)

        # video record
        with page.expect_download(timeout=30000) as dl2:
            page.click('#btn-record')
            page.wait_for_timeout(2500)
            page.click('#btn-record')
        vid = dl2.value
        vid.save_as(os.path.join(SHOTS, '5-video.webm'))
        print('[12] recording saved:', vid.suggested_filename)

        # lite mode toggle
        page.click('#btn-lite')
        page.wait_for_timeout(1500)
        lite = page.evaluate('window.__fmc.state.lite')
        print('[13] lite mode:', lite)
        assert lite is True

        page.screenshot(path=os.path.join(SHOTS, '6-final.png'))

        # mobile layout pass
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(SHOTS, '7-mobile.png'))
        page.click('#btn-calib')
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(SHOTS, '8-mobile-calib.png'))
        print('[14] mobile layout screenshots taken')
        browser.close()

    real_errors = [e for e in errors if 'WebGL' not in e and 'SwiftShader' not in e
                   and 'GroupMarkerNotSet' not in e and 'Automatic fallback' not in e
                   and 'GPU' not in e]
    print('\n--- console warnings (informational) ---')
    for w in warnings[:8]:
        print('  ', w[:160])
    print('--- errors ---')
    if real_errors:
        for e in real_errors:
            print('  ', e[:300])
        sys.exit(1)
    print('NO FATAL ERRORS — SMOKE TEST PASSED')

if __name__ == '__main__':
    main()
