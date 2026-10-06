# 🎭 Face Mask Camera

A Snapchat-style live face-filter **website** that runs **100% in the browser** — no backend,
no accounts, no uploads. Upload any mask / anime / animal image and it sticks to your face,
blinks when you blink, and opens its mouth when you open yours.

Built with **MediaPipe Face Landmarker** (478 landmarks, 52 blendshapes, facial transformation
matrix) + **Three.js** (the uploaded image is texture-mapped onto the canonical MediaPipe face
mesh through its UV coordinates).

## Run it

Any static server works (there is no build step):

```bash
cd face-mask-camera
python3 -m http.server 8000 --bind 0.0.0.0
# open https://<host>:8000  — camera access needs a secure context (HTTPS or localhost)
```

Everything (Three.js, MediaPipe Tasks-Vision + wasm, the face-landmarker model and the canonical
face mesh) is vendored in `vendor/` and `assets/`, so the site works offline after first load.
Only the optional **AI background removal** (@imgly/background-removal) streams from a CDN on
first use.

## Features

- **Live mask on your webcam** — the uploaded image is mapped onto the canonical face-mesh UVs;
  the mesh deforms with your 478 tracked landmarks, so expressions copy automatically. The alpha
  hull covers the **full face oval**, so masks cover the whole face.
- **Smooth by design** — face detection runs in a **dedicated Web Worker**, so the MediaPipe
  WASM inference never blocks the render loop (which targets your display's 60 fps). Detection
  runs on an *adaptive cadence* (33-100 ms, based on measured cost) and landmark snapshots are
  interpolated between detections, so the mask glides even at 10-15 Hz detection. Default camera
  is 640×480; pixel ratio is capped (1.5, or 1 in Lite). If a worker is unavailable the app
  falls back to main-thread detection automatically.
- **Blendshapes + face matrix** — 52 blendshapes drive extra "puppet" micro-deformations
  (blink squeeze, jaw drop, smile stretch); the facial transformation matrix stabilizes the mask
  (EMA-smoothed rigid correction) and feeds the head-pose HUD (yaw/pitch/roll).
- **Calibration screen with 6 draggable points** (eyes, nose, mouth, chin, forehead). Works with
  *any* artwork — anime, animals, robots — no real face required. A projective homography fits the
  6 image points to the mesh's canonical UV anchors, so any drawing conforms to the face.
  Auto-detect tries MediaPipe on the artwork first; manual drag always works.
- **In-browser background removal** — instant offline flood-fill (global-tolerance, border-seeded)
  plus optional AI removal via @imgly/background-removal; or keep the original.
- **Minimal live UI** — top-right shows only **＋ upload** and **⋯ more**; the ⋯ sheet holds the
  mask gallery, opacity/scale sliders, capture buttons and toggles (mirror, expression boost,
  calibration, debug dots, lite, camera switch). Recording shows a floating red timer pill.
- **Opacity & scale sliders**, **mirror toggle**, **expression-boost toggle**, landmark debug dots.
- **📷 Photo capture** and **⏺ video recording** (canvas.captureStream + MediaRecorder, audio
  included when permitted; MP4/WebM depending on browser).
- **Mask gallery** — 4 built-in masks (kitsune, robot, cat, anime) + masks you save, kept in `localStorage` only.
- **⚡ Lite mode** for slow devices (640×480, detection every 2nd frame, pixelRatio 1) with an
  automatic "switch to Lite?" suggestion when FPS stays under ~24 (target 30 fps).
- **Mobile-friendly** — bottom-sheet controls, touch-drag calibration (pointer events),
  safe-area insets, camera switch for front/back cameras.
- **Copyright notice on upload** — a rights gate asks for confirmation before any upload;
  permanent notices live on the welcome screen and the ℹ️ panel.

## Privacy

The camera feed and your images never leave the device. Saved masks live in your browser's
localStorage. Only use images you created or have permission to use.

## Self-hosting (it's just static files)

There is no backend, no build step and no environment config — any static file host works.
The only hard requirement: the page must run on **HTTPS or localhost** (browser camera rule).

- **Local:** `python3 -m http.server 8000` → open `http://localhost:8000` (localhost counts
  as a secure context).
- **Netlify:** drag the `face-mask-camera` folder onto https://app.netlify.com/drop → you get
  an HTTPS URL instantly.
- **GitHub Pages / Vercel / Cloudflare Pages:** upload the folder as a static site; set the
  publish directory to the folder root. No framework/build settings needed.
- **Any nginx/apache/VPS:** copy the folder and serve it; make sure `.wasm` is sent as
  `application/wasm` (most servers do this by default; python's http.server does too).

Everything (Three.js, MediaPipe wasm + model, face mesh, built-in masks) is vendored, so the
deployed site works without any other internet access. The single exception is the optional
**✨ AI BG** button, which streams its ONNX model from a CDN on first use (~40 MB) — the
offline **🧽 Simple BG** button is the fallback.

## Layout

```
index.html              UI shell (welcome / HUD / calibration sheet / modals)
css/styles.css          mobile-first dark UI
js/geom.js              pure math: OBJ parser, DLT homography, convex-hull alpha,
                        flood-fill background removal (unit-tested in Node)
js/face.js              FaceLandmarker wrapper (GPU→CPU fallback, lite mode, FPS)
js/scene.js             Three.js: video plane + masked face mesh (custom shader),
                        blendshape puppet regions, matrix stabilization
js/bgrm.js              upload pipeline: letterbox canvas, quick + AI background removal
js/media.js             photo capture + MediaRecorder
js/gallery.js           built-ins + localStorage gallery
js/main.js              orchestration / UI wiring
assets/canonical_face_model.obj   MediaPipe canonical face (468 verts + UVs, 898 tris)
assets/masks/*.png      pre-cut built-in masks (chroma-keyed offline)
vendor/                 three.module.min.js, @mediapipe/tasks-vision + wasm, face_landmarker.task
tests/                  Node math tests + headless Playwright E2E smoke test
```

## Tests

```bash
node tests/geom.test.mjs        # 17 unit tests: OBJ parse, homography, hull, flood-fill
python3 tests/make_y4m.py       # build a fake-webcam Y4M with a real face
python3 tests/make_y4m_turn.py  # fake-webcam Y4M with a 15-deg head turn
python3 tests/smoke.py          # full E2E in headless Chromium (needs `pip install playwright`)
python3 tests/audit.py          # 29-point feature audit (every control + regression checks)
python3 tests/drift.py          # head-turn drift regression (mask must stay on the face)
BUG=1 python3 tests/drift.py    # negative control: must FAIL with the old cm/screen-unit bug
```

The smoke test boots the site with a fake webcam (Y4M portrait), asserts tracking
(478 landmarks / 52 blendshapes / 1 matrix), drags calibration points, walks the upload +
copyright gate, captures a photo and a recording, toggles lite mode and screenshots desktop +
mobile layouts into `tests/shots/`.
