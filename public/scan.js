// public/scan.js — in-app QR scanner. Nothing here runs until the user presses
// "Сканировать QR": the camera is requested on click, the fallback decoder is
// fetched on click, and closing the window always stops the stream. Camera
// frames are drawn into a canvas that is wiped on close; they are never stored,
// never encoded as a file and never sent anywhere.

let jsqrPromise = null;

// Lazy: /vendor/jsQR.js (~250 KB, MIT, hosted in this project) is only fetched
// by browsers without a native BarcodeDetector, and only when the scanner opens.
function loadJsQR() {
  if (globalThis.jsQR) return Promise.resolve(globalThis.jsQR);
  if (!jsqrPromise) {
    jsqrPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsQR.js'; // same origin: CSP script-src 'self' stays intact
      s.async = true;
      s.onload = () => resolve(globalThis.jsQR);
      s.onerror = () => { jsqrPromise = null; reject(new Error('decoder_load_failed')); };
      document.head.appendChild(s);
    });
  }
  return jsqrPromise;
}

export function canScan() {
  // The decoder is fetched on demand, so all the browser needs is the camera API.
  return !!globalThis.navigator?.mediaDevices?.getUserMedia;
}

export function hasNativeDetector() {
  return typeof globalThis.BarcodeDetector === 'function';
}

// Maps a getUserMedia rejection to a message the user can act on.
export function cameraErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Доступ к камере запрещён. Разрешите его в настройках браузера.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена.';
  if (name === 'NotReadableError') return 'Камера занята другим приложением.';
  if (!globalThis.isSecureContext) return 'Камера доступна только по HTTPS.';
  return 'Не удалось включить камеру.';
}

// Starts scanning. Returns { promise, stop }: `promise` resolves with the raw
// QR text, or rejects with Error('stopped') / Error('camera_denied: …').
export async function startScan({ video, canvas, interval = 260 }) {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');

  let stream;
  try {
    stream = await globalThis.navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
  } catch (err) {
    throw new Error(`camera_denied:${cameraErrorMessage(err)}`);
  }

  let detector = null;
  if (hasNativeDetector()) {
    try { detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
  }
  let jsQR = null;
  if (!detector) {
    try {
      jsQR = await loadJsQR();
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('decoder_unavailable');
    }
  }

  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => { /* autoplay quirks are not fatal here */ });

  const ctx = canvas.getContext ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  let stopped = false;
  let timer = 0;
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

  function teardown() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    try { video.pause(); } catch { /* noop */ }
    video.srcObject = null;
    // Wipe anything we drew from the camera, then release the buffer.
    if (ctx && canvas.width) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
  }
  // Exactly one of these may settle the promise — a hit must not be turned into
  // a cancellation by the shared cleanup path.
  const succeed = (value) => { if (stopped) return; teardown(); resolveFn(value); };
  const abort = () => { if (stopped) return; teardown(); rejectFn(new Error('stopped')); };

  async function tick() {
    if (stopped) return;
    try {
      if (video.readyState >= 2) {
        if (detector) {
          const found = await detector.detect(video);
          if (found && found.length) {
            succeed(found[0].rawValue ?? found[0].value ?? '');
            return;
          }
        } else if (ctx) {
          const vw = video.videoWidth || 320;
          const vh = video.videoHeight || 240;
          const scale = Math.min(1, 640 / Math.max(vw, vh));
          canvas.width = Math.round(vw * scale);
          canvas.height = Math.round(vh * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) {
            succeed(code.data);
            return;
          }
        }
      }
    } catch {
      /* one dropped frame must not end the session; the next tick retries */
    }
    if (!stopped) timer = setTimeout(tick, interval);
  }
  timer = setTimeout(tick, 0);

  return { promise, stop: abort };
}
