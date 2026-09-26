// Camera + barcode decoding. Uses the browser's native BarcodeDetector when it
// covers the core formats (Android Chrome); otherwise the vendored zxing-wasm
// ponyfill. Same API either way. Adapted from StockTracker's scanner.js with a
// tolerant format gate, camera (deviceId) selection and zoom.

const WANTED = ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39', 'code_93', 'itf', 'qr_code', 'data_matrix'];
const CORE = ['upc_a', 'ean_13', 'code_128', 'code_39', 'qr_code'];

let _detector = null;
let _detectorKind = null;
let _formats = [];

export async function getDetector() {
  if (_detector) return _detector;
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const use = WANTED.filter(f => supported.includes(f));
      if (use.length && CORE.every(f => use.includes(f))) {
        _detector = new window.BarcodeDetector({ formats: use });
        _detectorKind = 'native';
        _formats = use;
        return _detector;
      }
    } catch { /* fall through to the ponyfill */ }
  }
  const NS = window.BarcodeDetectionAPI;
  if (!NS) throw new Error('Barcode library failed to load');
  NS.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? './vendor/zxing/zxing_reader.wasm' : prefix + path),
    },
  });
  _detector = new NS.BarcodeDetector({ formats: WANTED });
  _detectorKind = 'wasm';
  _formats = WANTED;
  return _detector;
}

export function detectorKind() { return _detectorKind; }
export function detectorFormats() { return _formats; }

/** Decode barcodes from a photo (File/Blob). Returns array of {rawValue, format}. */
export async function scanImage(fileOrBlob) {
  const detector = await getDetector();
  let source;
  try {
    source = await createImageBitmap(fileOrBlob);
  } catch {
    source = await blobToImage(fileOrBlob);
  }
  return detector.detect(source);
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

const DETECT_INTERVAL_MS = 130;   // ~8 detect passes per second
const ABSENCE_MS = 900;           // a code must leave the frame this long to count again
const RESUME_WARMUP_MS = 1200;    // after resume(), re-seen codes don't refire immediately

export class Scanner {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
    this.deviceId = null;
    this.onCode = null;          // (rawValue, format) => void
    this.onError = null;
    this._raf = 0;
    this._lastPass = 0;
    this._seen = new Map();
    this._paused = false;
    this._warmUntil = 0;
    this._running = false;
  }

  /** Cameras the browser exposes (labels are empty until permission is granted). */
  static async listCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === 'videoinput').map(d => ({ deviceId: d.deviceId, label: d.label || '' }));
    } catch { return []; }
  }

  async start({ deviceId = null, facing = 'environment', zoom = null } = {}) {
    this.stop();
    await getDetector();
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    let constraints;
    if (deviceId) constraints = { audio: false, video: { ...base, deviceId: { exact: deviceId } } };
    else constraints = { audio: false, video: { ...base, facingMode: facing === 'user' ? 'user' : { ideal: 'environment' } } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (!deviceId || !(e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError'))) throw e;
      // The remembered camera is gone (OS update, different lens set) — fall back to the rear camera.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, facingMode: { ideal: 'environment' } } });
      deviceId = null;
    }
    this.track = this.stream.getVideoTracks()[0];
    this.facing = facing;
    try { this.deviceId = this.track.getSettings().deviceId || deviceId; } catch { this.deviceId = deviceId; }
    this.video.srcObject = this.stream;
    this.video.classList.toggle('mirror', facing === 'user');
    try { await this.video.play(); } catch { /* play() may resolve late; the stream still renders */ }
    try { await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* optional */ }
    if (zoom) await this.setZoom(zoom);
    this._running = true;
    this._seen.clear();
    this._warmUntil = 0;
    this._loop();
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      this.track = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  get active() { return this._running && !!this.stream; }

  async flip() {
    const next = this.facing === 'user' ? 'environment' : 'user';
    await this.start({ facing: next });
    return next;
  }

  hasTorch() {
    try { return this.track?.getCapabilities?.().torch === true; } catch { return false; }
  }

  async setTorch(on) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch { return false; }
  }

  zoomRange() {
    try {
      const z = this.track?.getCapabilities?.().zoom;
      return z && typeof z.max === 'number' && z.max > (z.min || 0) ? { min: z.min || 1, max: z.max, step: z.step || 0.1 } : null;
    } catch { return null; }
  }

  getZoom() {
    try { return this.track?.getSettings?.().zoom ?? null; } catch { return null; }
  }

  async setZoom(value) {
    if (!this.track) return false;
    const r = this.zoomRange();
    if (!r) return false;
    const v = Math.min(r.max, Math.max(r.min, Number(value) || r.min));
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: v }] });
      return true;
    } catch { return false; }
  }

  /** Keep the stream alive but stop firing onCode (used while a sheet is open). */
  pause() { this._paused = true; }
  resume() {
    this._paused = false;
    this._warmUntil = performance.now() + RESUME_WARMUP_MS;
  }
  get paused() { return this._paused; }

  _loop() {
    this._raf = requestAnimationFrame(async (ts) => {
      if (!this._running) return;
      if (ts - this._lastPass >= DETECT_INTERVAL_MS && this.video.readyState >= 2 && this.video.videoWidth > 0) {
        this._lastPass = ts;
        try {
          const codes = await getDetector().then(d => d.detect(this.video));
          if (this._running && !this._paused) {
            const now = performance.now();
            const warm = now < this._warmUntil;
            for (const c of codes) {
              const value = c.rawValue;
              if (!value) continue;
              const last = this._seen.get(value) ?? -Infinity;
              const isNewAppearance = now - last > ABSENCE_MS;
              this._seen.set(value, now);
              if (isNewAppearance && !warm && this.onCode) {
                this.onCode(value, c.format);
                break; // one code per pass keeps multi-code frames predictable
              }
            }
          } else if (codes.length) {
            const now = performance.now();
            for (const c of codes) if (c.rawValue) this._seen.set(c.rawValue, now);
          }
        } catch (e) {
          if (this.onError && this._running) this.onError(e);
        }
      }
      if (this._running) this._loop();
    });
  }
}
