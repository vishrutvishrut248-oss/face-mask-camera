# Pro fullscreen camera — implementation and validation

Static website. No accounts, cloud upload, API keys or external assets required.
Deploy `index.html`, `grade.js`, `pro.js` together to an HTTPS static host.

## Implemented
- Original + 11 looks: Cinema, Golden, Arctic, Soft Film, Mono, Noir, Sunset,
  Neon, Portrait, Crisp, Vintage. Horizontal swipe on preview or tap a look.
- WebGL single-pass colour processing: exposure, contrast, saturation, warmth,
  shadows/highlights, vignette, grain and optional four-neighbour sharpening.
- Blendable preset intensity; reset; optional baked-in black cinema bars.
- The processed preview canvas, NOT the raw camera, feeds MediaRecorder.
- Output is limited to source dimensions: 1080p preferred by default, selectable
  4K/720p. The camera preference and processed output dimensions are displayed
  separately. No frame interpolation or artificial upscaling.
- Hardware controls are built from actual track capabilities: focus mode/distance,
  exposure mode/compensation/time/ISO, white balance mode/temperature, zoom, torch.
  Unexposed controls are labelled unsupported. ISO/focus/WB values only enabled
  in the relevant manual mode. Camera settings preserved when constraints applied.
- Tap-to-request-focus only when browser reports pointsOfInterest plus autofocus
  mode support. Focus-ring is a request indicator, not proof of optical focus.
- Microphone, download, camera switch, fullscreen, timer, visibility stop and
  camera-denied recovery retained.

## Research
- MDN, MediaStreamTrack.getCapabilities:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/getCapabilities
- W3C Image Capture (hardware ranges/modes): https://www.w3.org/TR/image-capture/
- MDN, applyConstraints:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/applyConstraints
- MDN, canvas captureStream:
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream
- MDN, video frame callback:
  https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback

Capabilities differ by device/browser. Advanced constraints may be ignored by a
camera; UI reads current settings back and does not claim unsupported controls work.
Exposure time uses camera-reported units, not a fabricated shutter-speed display.
Digital grading controls are not sensor ISO, optical focus or true HDR processing.

## Verification
`python3 test_pro.py`: 21 checks passed in Chromium fake-camera environment.
Checks include output-pixel changes, monochrome intensity, brightness, cinema bars,
all preset GL errors, swipe, real recording/download, decoded saved-video grading
and bars, output dimensions and disabled resolution during recording. ISO/focus
integration tested with capability mocks, NOT actual optical hardware.
`python3 test_camera.py`: 14 existing checks passed, including fallback, microphone,
record/download, quality and camera switches, viewport layout and denied permission.

No real phone 4K60, iPhone/Safari, optical focus, shutter, ISO, thermal behaviour,
long-recording stability or subjective real-scene colour accuracy was verified.
Software canvas processing adds load; requested 60 FPS is not guaranteed. Output
FPS can be lower than source FPS. Encoding is browser-dependent, not cinema-camera
quality or guaranteed HDR. Clips are held in memory until saved; long recordings
can exhaust device memory. Save clips frequently.

## Motion + blockbuster-inspired update
- Eight additional original split-tone looks, for 20 total. No official movie LUT
  or exact Avengers: Doomsday match is claimed. New presets use independent RGB
  shadow and highlight tinting in addition to existing contrast/colour controls.
- 1–6× digital zoom: buttons, slider and two-pointer pinch; the crop is baked into
  saved video. Digital zoom loses detail; no optical magnification is claimed.
  Existing hardware camera zoom remains separate in Pro where exposed.
- Default source preference is now 1080p60, then 720p60, before 30 FPS fallback.
  User can still choose 4K priority from the mode menu. Motion Boost explicitly
  switches to 720p60-preferred capture and 720p processing; no guaranteed 60 FPS.
- Reuse the RGBA texture with texSubImage2D when dimensions stay constant rather
  than redefine the texture each frame. Shader remains one pass; split tints
  do not add another rendering pass.
- Display source-delivered versus processed FPS separately. No fabricated frames
  or interpolation. Better lighting/shorter supported exposure may help sensor
  motion blur; colour grading cannot fix missing detail, focus or motion blur.
- Regression: Pro 21, camera 14, torch capability cases 6, motion/zoom 12 passed.
  Saved clip decoding confirms digital zoom is in output. API selection tested
  with mocks; synthetic frame patterns verify zoom. No real-phone FPS or thermal
  test performed, and no measured speedup is asserted for physical devices.

## Offline Smooth 60 export (Android / Chrome)

This is a new capture/export path, not another filter-only update.

### User flow
1. Fast capture is ON by default: MediaRecorder records the camera track directly,
   avoiding the live canvas readback/encoding bottleneck. Original download is raw.
   During capture the preview is limited to 540p/24 FPS to leave device headroom;
   that preview cadence/resolution does NOT set the original camera recording mode.
2. Selected look, colour controls and digital zoom are frozen at record start.
3. Stop → original clip available → Smooth 60 FPS export → select 720p/1080p → process.
4. Worker decodes sequentially, estimates forward/backward block motion on a small
   luminance image, warps/interpolates adjacent frames, applies the frozen grade,
   and encodes one frame per 1/60-second timestamp. This is classical synthetic
   motion interpolation, NOT trained AI, native camera 60 FPS, or recovered detail.
5. MP4/AVC preferred; VP9/WebM fallback if AVC encoding is unavailable. Audio copied
   losslessly where compatible or transcoded if required. Original URL is unchanged.
6. Export validates encoded packet count and 1/60-second timestamp spacing before
   exposing the result for download. Original stays available if processing fails.

### Dependencies / deployment
Mediabunny 1.62.1, MPL-2.0, vendored in `vendor/export-worker.js` with license file.
`export-worker-entry.js` and `motion-estimate.js` are the editable application source.
Build: `npx esbuild export-worker-entry.js --bundle --format=esm --target=es2022 --minify --outfile=vendor/export-worker.js`.
Everything runs on device; no server processing, CDN or COOP/COEP headers required.
WebCodecs, worker OffscreenCanvas/WebGL and suitable codecs must be available.

### Research
- MDN captureStream: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream
- MDN requestVideoFrameCallback: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- Mediabunny quick start: https://mediabunny.dev/guide/quick-start
- Mediabunny media sources: https://mediabunny.dev/guide/media-sources

### Measured verification (synthetic sources, NOT a phone-quality benchmark)
- Browser camera-to-export integration: direct camera path, audio preservation,
  original download unchanged, no upscaling, decoded Mono grade and download pass.
- Controlled 10 FPS input, duration 0.5s -> 30 encoded output frames at 60 FPS.
  Maximum timestamp-step error: 5.20e-17s. Intermediate-frame mean error against
  known 2px motion: 3.29, versus 84.31 for a repeated-frame reference. This validates
  non-duplicate intermediate-frame synthesis in this controlled translation case.
- Existing 21 Pro, 14 camera, 12 motion/zoom, and 6 torch regressions pass.

### Limits
- Experimental low-resolution block matching is NOT studio optical flow quality.
  Hands, occlusions, fast motion, flashing lights and detailed edges can warp or ghost.
- Scene-cut heuristic avoids some cross-cut synthesis; it is not infallible.
- Export caps: 3 minutes, 350 MiB source, at most 1080p preferred (never upscaled).
  In-memory output can still exhaust a low-memory phone. Start with short clips.
- Processing can take longer than the video. Keep tab visible/device awake. Cancellation
  terminates the worker and preserves the original. No universal codec/hardware guarantee.
- No real Android phone FPS, latency, thermals, artifact quality or long-clip test performed.
