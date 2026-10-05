/* main.js — UI orchestration: boot, camera, upload pipeline, calibration,
 * gallery, capture/record, performance management. No backend anywhere. */
import { FaceTracker } from './face.js';
import { MaskScene, ANCHOR_LANDMARKS } from './scene.js';
import { parseOBJ } from './geom.js';
import { TEX_SIZE, loadImageFile, toMaskCanvas, quickRemoveBackground, borderUniformity, aiRemoveBackground } from './bgrm.js';
import { downloadBlob, captureCanvasPNG, VideoRecorder } from './media.js';
import { BUILTIN_MASKS, loadUserMasks, saveUserMask, deleteUserMask } from './gallery.js';
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const glCanvas = $('gl');
const video = $('cam');

/* ------------------------------- state ---------------------------------- */
const state = {
  started: false,
  lite: false,
  facing: 'user',
  rightsOk: false,
  calibOpen: false,
  recording: false,
  current: null,   // { id, name, orig(canvas), processed(canvas), calib[{x,y}x6], flip }
  calibCache: new Map(), // mask id -> calib
};
const tracker = new FaceTracker();
const scene = new MaskScene(glCanvas);
const recorder = new VideoRecorder();
let cameraStream = null;
let imageLandmarker = null;
let rafId = 0, lastT = 0, fpsFrames = 0, fpsLast = 0, lowFpsSince = 0, liteSuggested = false;
let recTimer = null, recStartedAt = 0;

const DEFAULT_CALIB = [
  { x: 0.345, y: 0.40 }, { x: 0.655, y: 0.40 }, { x: 0.50, y: 0.56 },
  { x: 0.50, y: 0.70 },  { x: 0.50, y: 0.87 },  { x: 0.50, y: 0.19 },
];
const POINT_META = [
  { label: 'L eye', color: '#f472b6' }, { label: 'R eye', color: '#60a5fa' },
  { label: 'Nose', color: '#34d399' },  { label: 'Mouth', color: '#fbbf24' },
  { label: 'Chin', color: '#a78bfa' },  { label: 'Forehead', color: '#f87171' },
];

/* ------------------------------- helpers -------------------------------- */
function toast(msg, ms = 3600, actionLabel = null, action = null) {
  const el = $('toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (actionLabel && action) {
    const b = document.createElement('button');
    b.className = 'btn small primary';
    b.textContent = actionLabel;
    b.onclick = () => { el.hidden = true; action(); };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function setBootStatus(msg, isErr = false) {
  const el = $('boot-status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

/* ------------------------------- camera --------------------------------- */
async function startCamera() {
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  const idealW = state.lite ? 640 : 1280, idealH = state.lite ? 480 : 720;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: state.facing, width: { ideal: idealW }, height: { ideal: idealH } },
    audio: false,
  });
  video.srcObject = cameraStream;
  await video.play();
  tracker.lastVideoTime = -1;
  scene.attachVideo(video);
}

/* --------------------------- still-image landmarker ---------------------- */
async function getImageLandmarker() {
  if (imageLandmarker) return imageLandmarker;
  const vision = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm/');
  const base = { numFaces: 1, runningMode: 'IMAGE' };
  try {
    imageLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate: 'GPU' }, ...base,
    });
  } catch {
    imageLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate: 'CPU' }, ...base,
    });
  }
  return imageLandmarker;
}

function anchorsFromLandmarks(lms) {
  return ANCHOR_LANDMARKS.map(group => {
    let x = 0, y = 0;
    for (const li of group) { x += lms[li].x; y += lms[li].y; }
    return { x: x / group.length, y: y / group.length };
  });
}

/** Try to auto-place the 6 calibration points on an uploaded artwork.
 * Returns null when no face-like structure is found (user calibrates manually). */
async function autoCalibrate(canvas) {
  try {
    const lm = await getImageLandmarker();
    const res = lm.detect(canvas);
    if (res && res.faceLandmarks && res.faceLandmarks.length) return anchorsFromLandmarks(res.faceLandmarks[0]);
  } catch (e) { console.warn('auto-calibrate failed', e); }
  return null;
}

/* ------------------------------ mask pipeline ---------------------------- */
function applyCurrentMask() {
  const c = state.current;
  if (!c || !c.processed || !c.calib) return;
  scene.setMaskTexture(c.processed, c.calib, c.flip);
  renderThumbs();
  if (document.getElementById('calib').hidden === false) drawCalib();
}

async function ingestUpload(file) {
  try {
    const img = await loadImageFile(file);
    const orig = toMaskCanvas(img);
    let processed = orig;
    const uniform = borderUniformity(orig);
    if (uniform > 0.5) processed = quickRemoveBackground(orig, 34); // plain bg → instant cutout
    state.current = {
      id: 'user-' + Date.now(),
      name: (file.name || 'mask').replace(/\.[^.]+$/, '').slice(0, 28),
      orig, processed, flip: false,
      calib: DEFAULT_CALIB.map(p => ({ ...p })),
    };
    applyCurrentMask();
    openCalib();
    // async: try auto-detect face in the artwork (anime/art often has none — that's fine).
    // Guard against races: only apply the result if the same mask is still current.
    const myId = state.current.id;
    autoCalibrate(orig).then(pts => {
      if (pts && state.current && state.current.id === myId) {
        state.current.calib = pts.map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }));
        state.calibCache.set(state.current.id, state.current.calib);
        applyCurrentMask();
        toast('Face found in the artwork — points placed automatically. Fine-tune by dragging.');
      }
    });
  } catch (e) {
    console.error(e);
    toast('Could not read that image. Try a PNG or JPG.');
  }
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

async function applyMaskById(id) {
  if (id.startsWith('builtin-')) {
    const def = BUILTIN_MASKS.find(m => m.id === id);
    if (!def) return;
    const img = await loadImageFromURL(def.src);
    const orig = toMaskCanvas(img);
    let calib = state.calibCache.get(id);
    if (!calib) {
      const auto = await autoCalibrate(orig);
      calib = auto ? auto.map(p => ({ x: clamp01(p.x), y: clamp01(p.y) })) : DEFAULT_CALIB.map(p => ({ ...p }));
      state.calibCache.set(id, calib);
    }
    state.current = { id, name: def.name, orig, processed: orig, calib, flip: false };
  } else {
    const m = loadUserMasks().find(x => x.id === id);
    if (!m) return;
    const img = await loadImageFromURL(m.dataURL);
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    state.current = {
      id: m.id, name: m.name, orig: canvas, processed: canvas,
      calib: m.calib.map(p => ({ ...p })), flip: !!m.flip,
    };
  }
  $('sl-scale').value = 100; scene.setMaskScale(1);
  applyCurrentMask();
}

function loadImageFromURL(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* --------------------------- thumbnails / gallery ------------------------- */
function makeThumb(maskLike, { deletable = false } = {}) {
  const b = document.createElement('button');
  b.className = 'thumb' + (state.current && state.current.id === maskLike.id ? ' active' : '');
  b.title = maskLike.name;
  const img = document.createElement('img');
  img.src = maskLike.src || maskLike.dataURL;
  img.alt = maskLike.name;
  img.draggable = false;
  b.appendChild(img);
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = maskLike.name;
  b.appendChild(nm);
  if (deletable) {
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteUserMask(maskLike.id);
      renderThumbs(); renderGallery();
      toast('Mask deleted from this browser.');
    };
    b.appendChild(del);
  }
  b.onclick = () => { applyMaskById(maskLike.id); };
  return b;
}

function renderThumbs() {
  const strip = $('maskstrip');
  strip.querySelectorAll('.thumb:not(.upload)').forEach(el => el.remove());
  for (const m of BUILTIN_MASKS) strip.appendChild(makeThumb(m));
  for (const m of loadUserMasks()) strip.appendChild(makeThumb(m, { deletable: true }));
}

function renderGallery() {
  const grid = $('gallery-grid');
  grid.innerHTML = '';
  for (const m of BUILTIN_MASKS) grid.appendChild(makeThumb(m));
  for (const m of loadUserMasks()) grid.appendChild(makeThumb(m, { deletable: true }));
}

/* ----------------------------- calibration UI ----------------------------- */
const calibCanvas = $('calib-canvas');
const calibCtx = calibCanvas.getContext('2d');
let dragIdx = -1;

function openCalib() {
  if (!state.current) { toast('Upload or pick a mask first.'); return; }
  $('calib').hidden = false;
  state.calibOpen = true;
  $('btn-calib').classList.add('on');
  sizeCalibCanvas();
  drawCalib();
}
function closeCalib() {
  $('calib').hidden = true;
  state.calibOpen = false;
  $('btn-calib').classList.remove('on');
}
function sizeCalibCanvas() {
  const stage = document.querySelector('.calib-stage');
  const avail = Math.min(stage.clientWidth - 8, stage.clientHeight - 8);
  const css = Math.max(220, avail);
  calibCanvas.style.width = css + 'px';
  calibCanvas.style.height = css + 'px';
  calibCanvas.width = TEX_SIZE;
  calibCanvas.height = TEX_SIZE;
}

function drawCalib() {
  const c = state.current;
  if (!c) return;
  calibCtx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
  calibCtx.drawImage(c.processed, 0, 0, TEX_SIZE, TEX_SIZE);
  c.calib.forEach((p, i) => {
    const x = p.x * TEX_SIZE, y = p.y * TEX_SIZE;
    const meta = POINT_META[i];
    calibCtx.beginPath();
    calibCtx.arc(x, y, 22, 0, Math.PI * 2);
    calibCtx.fillStyle = meta.color + '33';
    calibCtx.fill();
    calibCtx.lineWidth = 5;
    calibCtx.strokeStyle = meta.color;
    calibCtx.stroke();
    calibCtx.beginPath();
    calibCtx.arc(x, y, 5, 0, Math.PI * 2);
    calibCtx.fillStyle = meta.color;
    calibCtx.fill();
    // label
    calibCtx.font = '600 20px system-ui, sans-serif';
    const tw = calibCtx.measureText(meta.label).width;
    const ly = y - 34 < 24 ? y + 46 : y - 34;
    calibCtx.fillStyle = 'rgba(0,0,0,0.65)';
    calibCtx.fillRect(x - tw / 2 - 6, ly - 16, tw + 12, 24);
    calibCtx.fillStyle = meta.color;
    calibCtx.textAlign = 'center';
    calibCtx.fillText(meta.label, x, ly + 2);
  });
}

function calibPointerPos(e) {
  const r = calibCanvas.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height),
  };
}
calibCanvas.addEventListener('pointerdown', (e) => {
  const p = calibPointerPos(e);
  let best = -1, bestD = 44 / calibCanvas.getBoundingClientRect().width; // 44 css px
  state.current.calib.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    dragIdx = best;
    calibCanvas.setPointerCapture(e.pointerId);
    moveCalibPoint(p);
  }
});
calibCanvas.addEventListener('pointermove', (e) => {
  if (dragIdx < 0) return;
  moveCalibPoint(calibPointerPos(e));
});
calibCanvas.addEventListener('pointerup', () => { dragIdx = -1; });
calibCanvas.addEventListener('pointercancel', () => { dragIdx = -1; });

function moveCalibPoint(p) {
  const c = state.current;
  c.calib[dragIdx] = { x: p.x, y: p.y };
  state.calibCache.set(c.id, c.calib);
  drawCalib();
  scene.updateCalib(c.calib, c.flip);   // live preview on the face mesh
}

/* --------------------------- capture / record ----------------------------- */
async function takePhoto() {
  scene.renderOnce();
  const flash = $('flash');
  flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('on')));
  try {
    const blob = await captureCanvasPNG(glCanvas);
    downloadBlob(blob, `maskcam-${Date.now()}.png`);
    toast('📷 Photo saved to your downloads.');
  } catch (e) { console.error(e); toast('Photo capture failed.'); }
}

async function toggleRecord() {
  if (!state.recording) {
    let audioStream = null;
    try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* silent recording */ }
    try {
      recorder.start(glCanvas, audioStream);
    } catch (e) {
      toast(e.message || 'Recording is not supported in this browser.');
      return;
    }
    state.recording = true;
    recStartedAt = Date.now();
    $('btn-record').classList.add('recording');
    $('btn-record').textContent = '⏹';
    $('btn-rec-chip').hidden = false;
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStartedAt) / 1000);
      $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
    toast('⏺ Recording… tap ⏹ to stop.', 2500);
  } else {
    state.recording = false;
    clearInterval(recTimer);
    $('btn-record').classList.remove('recording');
    $('btn-record').textContent = '⏺';
    $('btn-rec-chip').hidden = true;
    const blob = await recorder.stop();
    if (blob && blob.size > 0) {
      const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(blob, `maskcam-${Date.now()}.${ext}`);
      toast(`🎬 Video saved (${(blob.size / 1e6).toFixed(1)} MB).`);
    } else {
      toast('Recording produced no data.');
    }
  }
}

/* ------------------------------- main loop -------------------------------- */
function loop(t) {
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
  lastT = t;
  const result = tracker.detect(video);
  if (result && result.faceBlendshapes && result.faceBlendshapes.length) scene.setBlendshapes(result.faceBlendshapes[0]);
  scene.update(result, dt);

  // fps stats
  fpsFrames++;
  if (t - fpsLast > 500) {
    const fps = fpsFrames * 1000 / (t - fpsLast);
    fpsFrames = 0; fpsLast = t;
    $('chip-fps').textContent = `${Math.round(fps)} fps`;
    const p = scene.pose;
    $('chip-pose').textContent = `y${p.yaw.toFixed(0)}° p${p.pitch.toFixed(0)}° r${p.roll.toFixed(0)}°`;
    const on = !!p.tracking;
    $('chip-track').innerHTML = `<i class="dot ${on ? '' : 'off'}"></i>${on ? 'tracking' : 'no face'}`;
    // auto lite suggestion: sustained low fps
    if (!state.lite) {
      if (fps < 24) {
        if (!lowFpsSince) lowFpsSince = t;
        else if (t - lowFpsSince > 4000 && !liteSuggested) {
          liteSuggested = true;
          toast('Running below 30 fps — switch to Lite mode?', 8000, '⚡ Switch', () => setLite(true));
        }
      } else lowFpsSince = 0;
    }
  }
}

/* ------------------------------- controls --------------------------------- */
async function setLite(on) {
  if (state.lite === on) return;
  state.lite = on;
  tracker.setLite(on);
  scene.setLite(on);
  $('btn-lite').classList.toggle('on', on);
  setBootStatus(on ? '⚡ Lite mode: 640×480, detecting every 2nd frame.' : 'Full mode restored.');
  try { await startCamera(); } catch (e) { toast('Could not restart camera.'); }
}

function bindUI() {
  $('sl-opacity').addEventListener('input', (e) => scene.setOpacity(e.target.value / 100));
  $('sl-scale').addEventListener('input', (e) => scene.setMaskScale(e.target.value / 100));
  $('btn-mirror').addEventListener('click', () => {
    scene.mirror = !scene.mirror;
    $('btn-mirror').classList.toggle('on', scene.mirror);
  });
  $('btn-expr').addEventListener('click', () => {
    scene.expressionBoost = !scene.expressionBoost;
    $('btn-expr').classList.toggle('on', scene.expressionBoost);
  });
  $('btn-dots').addEventListener('click', () => {
    scene.debugDots = !scene.debugDots;
    $('btn-dots').classList.toggle('on', scene.debugDots);
  });
  $('btn-lite').addEventListener('click', () => setLite(!state.lite));
  $('btn-flipcam').addEventListener('click', async () => {
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    try {
      await startCamera();
      // selfie cam is mirrored; the rear camera must not be
      scene.mirror = state.facing === 'user';
      $('btn-mirror').classList.toggle('on', scene.mirror);
    } catch {
      state.facing = state.facing === 'user' ? 'environment' : 'user';
      toast('Only one camera available.');
    }
  });
  $('btn-photo').addEventListener('click', takePhoto);
  $('btn-record').addEventListener('click', toggleRecord);
  $('btn-rec-chip').addEventListener('click', toggleRecord);
  $('btn-calib').addEventListener('click', () => (state.calibOpen ? closeCalib() : openCalib()));
  $('calib-close').addEventListener('click', closeCalib);
  $('calib-done').addEventListener('click', closeCalib);
  $('calib-reset').addEventListener('click', () => {
    state.current.calib = DEFAULT_CALIB.map(p => ({ ...p }));
    drawCalib(); scene.updateCalib(state.current.calib, state.current.flip);
  });
  $('calib-flip').addEventListener('click', () => {
    state.current.flip = !state.current.flip;
    scene.updateCalib(state.current.calib, state.current.flip);
    toast(state.current.flip ? 'Mask flipped horizontally.' : 'Flip off.');
  });
  $('calib-auto').addEventListener('click', async () => {
    $('calib-progress').hidden = false;
    $('calib-progress').textContent = 'Detecting face in the artwork…';
    const pts = await autoCalibrate(state.current.orig);
    $('calib-progress').hidden = true;
    if (pts) {
      state.current.calib = pts.map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }));
      drawCalib(); scene.updateCalib(state.current.calib, state.current.flip);
      toast('Points placed automatically.');
    } else {
      toast('No face found in the artwork — drag the 6 points manually. That always works!');
    }
  });
  $('bg-simple').addEventListener('click', () => {
    state.current.processed = quickRemoveBackground(state.current.orig, 40);
    applyCurrentMask(); toast('Quick background removal applied (offline).');
  });
  $('bg-ai').addEventListener('click', async () => {
    const prog = $('calib-progress');
    prog.hidden = false; prog.textContent = '✨ Loading AI model (first time ≈ 40 MB, cached after)…';
    try {
      const out = await aiRemoveBackground(state.current.orig, (key, cur, total) => {
        prog.textContent = `✨ AI background removal… ${key} ${Math.round(100 * cur / Math.max(1, total))}%`;
      });
      // fit result back into the TEX_SIZE letterbox frame the calibration uses
      state.current.processed = toMaskCanvas(out);
      applyCurrentMask();
      toast('✨ AI background removal applied.');
    } catch (e) {
      console.error(e);
      toast('AI removal unavailable (offline?) — try 🧽 Simple BG.');
    }
    prog.hidden = true;
  });
  $('bg-none').addEventListener('click', () => {
    state.current.processed = state.current.orig;
    applyCurrentMask(); toast('Using the original image.');
  });

  /* upload + copyright gate */
  $('btn-upload').addEventListener('click', () => {
    if (state.rightsOk) $('file-input').click();
    else { $('rights').hidden = false; $('rights-check').checked = false; $('rights-ok').disabled = true; }
  });
  $('rights-check').addEventListener('change', (e) => { $('rights-ok').disabled = !e.target.checked; });
  $('rights-cancel').addEventListener('click', () => { $('rights').hidden = true; });
  $('rights-ok').addEventListener('click', () => {
    state.rightsOk = true;
    $('rights').hidden = true;
    $('file-input').click();
  });
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) ingestUpload(f);
  });

  /* save current mask */
  $('btn-save').addEventListener('click', () => {
    const c = state.current;
    if (!c) { toast('Nothing to save yet.'); return; }
    if (c.id.startsWith('builtin-')) { toast('Built-in masks are already in your gallery 😄'); return; }
    const name = (prompt('Name this mask:', c.name) || '').slice(0, 28);
    if (!name) return;
    const res = saveUserMask({
      id: 'user-' + Date.now(), name,
      dataURL: c.processed.toDataURL('image/png'),
      calib: c.calib.map(p => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) })),
      flip: c.flip,
    });
    if (res.ok) {
      c.id = res.masks[0].id;
      renderThumbs(); renderGallery();
      toast(res.dropped ? 'Saved (oldest mask removed to free space).' : '💾 Saved to your gallery.');
    } else toast(res.error);
  });

  /* modals */
  $('btn-gallery').addEventListener('click', () => { renderGallery(); $('gallery').hidden = false; });
  $('gallery-close').addEventListener('click', () => { $('gallery').hidden = true; });
  $('btn-info').addEventListener('click', () => { $('info').hidden = false; });
  $('info-close').addEventListener('click', () => { $('info').hidden = true; });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'rights') m.hidden = true; });
  });
  window.addEventListener('resize', () => { if (state.calibOpen) { sizeCalibCanvas(); drawCalib(); } });
}

/* --------------------------------- boot ----------------------------------- */
async function boot() {
  $('btn-start').disabled = true;
  try {
    setBootStatus('Requesting camera…');
    await startCamera();

    setBootStatus('Loading MediaPipe face landmarker (3.7 MB, local)…');
    tracker.onStatus = (s) => {
      if (s === 'loading-model') setBootStatus('Loading face model + blendshapes…');
    };
    await tracker.init();

    setBootStatus('Building face mesh…');
    const objText = await (await fetch('./assets/canonical_face_model.obj')).text();
    scene.setFaceModel(parseOBJ(objText));

    bindUI();
    renderThumbs(); renderGallery();

    $('welcome').style.display = 'none';
    $('hud').hidden = false;
    state.started = true;
    rafId = requestAnimationFrame(loop);

    // default mask
    applyMaskById('builtin-kitsune').then(() => toast('🎭 Try it: blink, open your mouth, turn your head. Upload your own mask with ＋'));
  } catch (e) {
    console.error(e);
    $('btn-start').disabled = false;
    const msg = (e && e.name === 'NotAllowedError')
      ? 'Camera permission denied. Allow camera access and try again (HTTPS required).'
      : (e && e.name === 'NotFoundError')
        ? 'No camera found on this device.'
        : 'Startup failed: ' + (e.message || e);
    setBootStatus(msg, true);
  }
}

$('btn-start').addEventListener('click', boot);

// debug/automation handle (used by the headless smoke test)
window.__fmc = { state, scene, tracker, applyMaskById, autoCalibrate };
