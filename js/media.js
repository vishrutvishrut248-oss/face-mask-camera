/* media.js — photo capture + video recording (MediaRecorder on the WebGL canvas). */

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Capture the WebGL canvas as PNG. Call right after a render. */
export function captureCanvasPNG(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export class VideoRecorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.stream = null;
  }

  get active() { return this.recorder && this.recorder.state === 'recording'; }

  /** canvas: WebGL canvas; audioStream: getUserMedia stream (audio track added). */
  start(canvas, audioStream) {
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      throw new Error('Recording is not supported in this browser. Try Chrome, Edge or Firefox.');
    }
    this.chunks = [];
    this.stream = canvas.captureStream(30);
    if (audioStream) {
      const at = audioStream.getAudioTracks()[0];
      if (at) this.stream.addTrack(at);
    }
    const mime = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(500);
    return mime || 'video/webm';
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(null);
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        this.stream && this.stream.getTracks().forEach(t => t.stop());
        this.recorder = null;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}
