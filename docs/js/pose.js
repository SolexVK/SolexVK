// Камера и распознавание позы. Видео обрабатывается на самом телефоне и никуда не уходит.
import { LM } from './coach.js';

let landmarker = null;
let loading = null;
let stream = null;
let raf = 0;
let running = false;

export const cameraSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export function loadModel() {
  if (landmarker) return Promise.resolve(landmarker);
  if (loading) return loading;
  loading = (async () => {
    const vision = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
    const make = (delegate) => vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('../models/pose_landmarker_lite.task', import.meta.url).href, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
    return landmarker;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export async function startCamera(video) {
  if (!cameraSupported) throw new Error('unsupported');
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

export function stopCamera() {
  stopLoop();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
export const cameraOn = () => !!stream;

const EDGES = [
  [LM.shL, LM.shR], [LM.shL, LM.elL], [LM.elL, LM.wrL], [LM.shR, LM.elR], [LM.elR, LM.wrR],
  [LM.shL, LM.hipL], [LM.shR, LM.hipR], [LM.hipL, LM.hipR],
  [LM.hipL, LM.knL], [LM.knL, LM.anL], [LM.hipR, LM.knR], [LM.knR, LM.anR],
];
const JOINTS = [LM.shL, LM.shR, LM.elL, LM.elR, LM.wrL, LM.wrR, LM.hipL, LM.hipR, LM.knL, LM.knR, LM.anL, LM.anR];

export function drawSkeleton(canvas, lm, { bad = false } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!lm) return;
  const k = Math.max(2, W / 160);
  ctx.lineCap = 'round';
  ctx.lineWidth = k;
  ctx.strokeStyle = bad ? 'rgba(255,170,90,0.95)' : 'rgba(140,235,205,0.95)';
  for (const [a, b] of EDGES) {
    if ((lm[a].visibility ?? 0) < 0.4 || (lm[b].visibility ?? 0) < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * W, lm[a].y * H);
    ctx.lineTo(lm[b].x * W, lm[b].y * H);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (const j of JOINTS) {
    if ((lm[j].visibility ?? 0) < 0.4) continue;
    ctx.beginPath();
    ctx.arc(lm[j].x * W, lm[j].y * H, k * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Цикл распознавания: около 15 кадров в секунду достаточно и бережёт батарею.
export function startLoop(video, canvas, onFrame) {
  stopLoop();
  running = true;
  let last = 0;
  let lastTs = 0;
  const tick = (now) => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (now - last < 66 || !landmarker || video.readyState < 2 || !video.videoWidth) return;
    last = now;
    if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    const ts = Math.max(lastTs + 1, Math.round(now));
    lastTs = ts;
    let res;
    try { res = landmarker.detectForVideo(video, ts); } catch { return; }
    const lm = res.landmarks?.[0] || null;
    const world = res.worldLandmarks?.[0] || null;
    const out = onFrame(lm, world, now, video.videoWidth / video.videoHeight) || {};
    drawSkeleton(canvas, lm, out);
  };
  raf = requestAnimationFrame(tick);
}

export function stopLoop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// Кадр для наставника: уменьшенный JPEG в base64.
export function snapshot(video, maxSide = 640) {
  if (!video.videoWidth) return null;
  const s = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * s);
  c.height = Math.round(video.videoHeight * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8).split(',')[1];
}
