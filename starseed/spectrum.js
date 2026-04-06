/* ═══════════════════════════════════════════════════════════════════
   Spectrum — diagnostic frequency analyzer
   64-band (default) bar visualizer with dual-layer raw/gated display,
   peak hold, band labels, and diagnostic controls.
   No narrative arc, no drift — pure real-time.
   ═══════════════════════════════════════════════════════════════════ */

// ── Three.js setup ──
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 1;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x060810, 1);
document.body.appendChild(renderer.domElement);

// ── Audio state ──
let audioContext, analyser, dataArray, source;
let currentBuffer = null, audioDuration = 0, audioStartTime = 0;
let playState = 'idle', currentFileName = '';
const frequencyUniform = new Float32Array(64);

// ── Diagnostic state ──
let threshold = 0.5;       // 0–1 (from slider 0–100)
let visualGain = 1.0;      // multiplier
let logFreqAxis = false;
let soloMode = false;
let soloRange = [0, 1];    // normalized 0–1 of bin range
let sampleRate = 48000;    // updated on audio init
let currentFFTSize = 128;
let binCount = 64;

// ── Peak hold state ──
let peakValues = new Float32Array(2048);  // max possible bins
let peakDecay = 0.985;

// ── Bar geometry ──
// We use a single PlaneGeometry per bar, managed as a group
const barGroup = new THREE.Group();
scene.add(barGroup);
const rawBars = [];       // dim bars showing raw amplitude
const gatedBars = [];     // bright bars showing post-gate amplitude
const peakDots = [];       // peak hold indicators
const MAX_BINS = 1024;     // max bins we'll support (fftSize 2048)

// Bar color gradient: warm red → yellow/green → cyan/blue
function binColor(normIdx) {
  // normIdx 0–1 across all bins
  const r = Math.max(0, 1.0 - normIdx * 2.5) * 0.9 + 0.1;
  const g = normIdx < 0.4 ? normIdx * 2.5 * 0.8 : (1.0 - (normIdx - 0.4) * 1.2) * 0.8;
  const b = Math.max(0, (normIdx - 0.3) * 1.43) * 0.9;
  return new THREE.Color(r, g, b);
}

function buildBars() {
  // Clear existing
  while (barGroup.children.length) barGroup.remove(barGroup.children[0]);
  rawBars.length = 0;
  gatedBars.length = 0;
  peakDots.length = 0;

  const margin = 0.04;
  const totalWidth = 2.0 - margin * 2;   // NDC -1 to 1
  const barGap = totalWidth * 0.005;
  const barWidth = (totalWidth - barGap * (binCount - 1)) / binCount;
  const barMaxHeight = 1.5;  // NDC units
  const baseY = -0.85;       // bottom of bars

  for (let i = 0; i < binCount; i++) {
    const normIdx = i / Math.max(binCount - 1, 1);
    const x = getBarX(i, margin, totalWidth);
    const color = binColor(normIdx);

    // Raw bar (dim)
    const rawGeo = new THREE.PlaneGeometry(barWidth, 1);
    const rawMat = new THREE.MeshBasicMaterial({
      color: color.clone().multiplyScalar(0.25),
      transparent: true, opacity: 0.4
    });
    const rawMesh = new THREE.Mesh(rawGeo, rawMat);
    rawMesh.position.set(x, baseY, 0);
    rawMesh.scale.y = 0.001;
    barGroup.add(rawMesh);
    rawBars.push(rawMesh);

    // Gated bar (bright)
    const gatedGeo = new THREE.PlaneGeometry(barWidth, 1);
    const gatedMat = new THREE.MeshBasicMaterial({
      color: color.clone(),
      transparent: true, opacity: 0.85
    });
    const gatedMesh = new THREE.Mesh(gatedGeo, gatedMat);
    gatedMesh.position.set(x, baseY, 0.01);
    gatedMesh.scale.y = 0.001;
    barGroup.add(gatedMesh);
    gatedBars.push(gatedMesh);

    // Peak dot
    const dotGeo = new THREE.PlaneGeometry(barWidth, barWidth * 0.3);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.7
    });
    const dotMesh = new THREE.Mesh(dotGeo, dotMat);
    dotMesh.position.set(x, baseY, 0.02);
    barGroup.add(dotMesh);
    peakDots.push(dotMesh);
  }

  // Reset peaks
  peakValues.fill(0);

  // Build Hz labels
  buildLabels();
}

function getBarX(i, margin, totalWidth) {
  if (!logFreqAxis || binCount <= 1) {
    // Linear spacing
    const barGap = totalWidth * 0.005;
    const barWidth = (totalWidth - barGap * (binCount - 1)) / binCount;
    return -1 + margin + barWidth / 2 + i * (barWidth + barGap);
  }
  // Logarithmic spacing — spread low bins, compress high bins
  const minLog = Math.log2(1);
  const maxLog = Math.log2(binCount);
  const logPos = Math.log2(i + 1) / maxLog;
  return -1 + margin + logPos * totalWidth;
}

// ── Hz labels ──
const labelCanvas = document.createElement('canvas');
const labelCtx = labelCanvas.getContext('2d');
let labelTexture, labelMesh;

function buildLabels() {
  const w = innerWidth * (window.devicePixelRatio || 1);
  const h = 60;
  labelCanvas.width = w;
  labelCanvas.height = h;
  labelCtx.clearRect(0, 0, w, h);
  labelCtx.font = `${Math.max(9, Math.round(w / 160))}px "Segoe UI", sans-serif`;
  labelCtx.textAlign = 'center';
  labelCtx.textBaseline = 'top';

  const hzPerBin = sampleRate / currentFFTSize;
  const margin = 0.04;
  const totalWidth = 2.0 - margin * 2;

  // Frequency tick labels — show ~10-15 evenly spaced labels
  const labelInterval = Math.max(1, Math.floor(binCount / 14));
  for (let i = 0; i < binCount; i += labelInterval) {
    const hz = Math.round(i * hzPerBin);
    const label = hz >= 1000 ? (hz / 1000).toFixed(1) + 'k' : String(hz);
    const normX = getBarX(i, margin, totalWidth);
    const canvasX = ((normX + 1) / 2) * w;
    labelCtx.fillStyle = 'rgba(80,180,220,0.4)';
    labelCtx.fillText(label, canvasX, 4);
  }
  // Last bin
  {
    const hz = Math.round((binCount - 1) * hzPerBin);
    const label = hz >= 1000 ? (hz / 1000).toFixed(1) + 'k' : String(hz);
    const normX = getBarX(binCount - 1, margin, totalWidth);
    const canvasX = ((normX + 1) / 2) * w;
    labelCtx.fillStyle = 'rgba(80,180,220,0.4)';
    labelCtx.fillText(label, canvasX, 4);
  }

  // Band group labels
  const bands = [
    { name: 'SUB', maxHz: 60 },
    { name: 'BASS', maxHz: 250 },
    { name: 'LOW-MID', maxHz: 500 },
    { name: 'MID', maxHz: 2000 },
    { name: 'HI-MID', maxHz: 4000 },
    { name: 'PRESENCE', maxHz: 8000 },
    { name: 'BRILLIANCE', maxHz: sampleRate / 2 }
  ];
  labelCtx.font = `bold ${Math.max(8, Math.round(w / 200))}px "Segoe UI", sans-serif`;
  let prevBin = 0;
  for (const band of bands) {
    const endBin = Math.min(Math.round(band.maxHz / hzPerBin), binCount - 1);
    if (endBin <= prevBin) continue;
    const midBin = Math.floor((prevBin + endBin) / 2);
    const normX = getBarX(midBin, margin, totalWidth);
    const canvasX = ((normX + 1) / 2) * w;
    labelCtx.fillStyle = 'rgba(80,180,220,0.22)';
    labelCtx.fillText(band.name, canvasX, 28);
    prevBin = endBin + 1;
  }

  if (!labelTexture) {
    labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.minFilter = THREE.LinearFilter;
    const labelGeo = new THREE.PlaneGeometry(2, 0.12);
    const labelMat = new THREE.MeshBasicMaterial({
      map: labelTexture, transparent: true, depthTest: false
    });
    labelMesh = new THREE.Mesh(labelGeo, labelMat);
    labelMesh.position.set(0, -0.94, 0.05);
    scene.add(labelMesh);
  } else {
    labelTexture.needsUpdate = true;
  }
}

// ── Amplitude grid lines ──
function buildGrid() {
  const gridGroup = new THREE.Group();
  gridGroup.name = 'grid';
  const mat = new THREE.LineBasicMaterial({ color: 0x50b4dc, transparent: true, opacity: 0.06 });
  const baseY = -0.85;
  const maxH = 1.5;
  for (let pct = 0.25; pct <= 1.0; pct += 0.25) {
    const y = baseY + pct * maxH;
    const pts = [new THREE.Vector3(-0.96, y, 0), new THREE.Vector3(0.96, y, 0)];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    gridGroup.add(new THREE.Line(geo, mat));
  }
  scene.add(gridGroup);
}

// ── Audio init ──
function initAudio(smoothing) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = audioContext.sampleRate;
  analyser = audioContext.createAnalyser();
  analyser.fftSize = currentFFTSize;
  analyser.smoothingTimeConstant = smoothing;
  binCount = analyser.frequencyBinCount;
  dataArray = new Uint8Array(binCount);
}

function ensureAudio() {
  if (!audioContext) initAudio(0.85);
  return { audioContext, analyser, dataArray };
}

function rebuildAnalyser() {
  if (!audioContext) return;
  const oldSmoothing = analyser ? analyser.smoothingTimeConstant : 0.85;

  // Disconnect old analyser
  const wasConnected = analyser && source;
  analyser = audioContext.createAnalyser();
  analyser.fftSize = currentFFTSize;
  analyser.smoothingTimeConstant = oldSmoothing;
  binCount = analyser.frequencyBinCount;
  dataArray = new Uint8Array(binCount);

  // Reconnect source if playing
  if (source && playState === 'playing') {
    try {
      source.disconnect();
      source.connect(analyser);
      analyser.connect(audioContext.destination);
    } catch (e) {}
  }

  buildBars();
}

// ── DOM refs ──
const fileInput = document.getElementById('file-input');
const playBtn = document.getElementById('play-btn');
const controlsEl = document.getElementById('controls');
const diagBar = document.getElementById('diag-bar');

// ── Audio file handling (same pattern as other scenes) ──
function showAudioReady() {
  document.getElementById('upload-area').style.display = 'none'; document.getElementById('audio-loader').style.display = 'none';
  document.getElementById('audio-ready').style.display = 'block';
  document.getElementById('audio-name').textContent = currentFileName;
  playBtn.textContent = '\u25b6\uFE0E Play';
  playState = 'idle';
}

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  currentFileName = file.name;
  if (!audioContext) initAudio(0.85);
  const reader = new FileReader();
  reader.onload = evt => {
    const raw = evt.target.result;
    audioContext.decodeAudioData(raw.slice(0), buf => {
      currentBuffer = buf;
      audioDuration = buf.duration;
      showAudioReady();
      AudioStore.save(raw, currentFileName);
    });
  };
  reader.readAsArrayBuffer(file);
});
AudioStore.load().then(data => {
  if (!data) { document.getElementById('audio-loader').style.display='none';document.getElementById('upload-area').style.display=''; return; }
  currentFileName = data.name;
  if (!audioContext) initAudio(0.85);
  audioContext.decodeAudioData(data.buffer, buf => {
    currentBuffer = buf;
    audioDuration = buf.duration;
    showAudioReady();
  });
}).catch(() => { document.getElementById('audio-loader').style.display='none';document.getElementById('upload-area').style.display=''; });

function applyAndLaunch() {
  if (playState === 'listening' && window.SCENE && window.SCENE._stopMic) window.SCENE._stopMic();
  controlsEl.classList.add('hidden');
  controlsEl.classList.remove('visible');
  diagBar.classList.add('active');
  buildBars();
}

playBtn.addEventListener('click', () => {
  if (!currentBuffer) return;
  applyAndLaunch();

  if (playState === 'paused') { audioContext.resume(); playState = 'playing'; return; }
  if (source) { source.onended = null; try { source.stop(); } catch (e) {} source.disconnect(); }
  source = audioContext.createBufferSource();
  source.buffer = currentBuffer;
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  if (audioContext.state === 'suspended') audioContext.resume();
  source.loop=true;source.start(0);
  audioStartTime = audioContext.currentTime;
  playState = 'playing';
  source.onended = () => {
    playState = 'idle';
    playBtn.textContent = '\u25b6\uFE0E Play';
    controlsEl.classList.remove('hidden');
    diagBar.classList.remove('active');
  };
});

document.getElementById('replace-btn').addEventListener('click', () => { fileInput.click(); });
renderer.domElement.addEventListener('click', () => {
  if (playState === 'playing') {
    audioContext.suspend();
    playState = 'paused';
    playBtn.textContent = '\u25b6\uFE0E Resume';
    controlsEl.classList.add('visible');
    controlsEl.classList.remove('hidden');
  }
});

// ── Diagnostic controls ──
const dThreshold = document.getElementById('d-threshold');
const dThresholdVal = document.getElementById('d-threshold-val');
const dSmoothing = document.getElementById('d-smoothing');
const dSmoothingVal = document.getElementById('d-smoothing-val');
const dFFT = document.getElementById('d-fft');
const dGain = document.getElementById('d-gain');
const dGainVal = document.getElementById('d-gain-val');
const dLog = document.getElementById('d-log');
const dSolo = document.getElementById('d-solo');

dThreshold.addEventListener('input', () => {
  threshold = dThreshold.value / 100;
  dThresholdVal.textContent = dThreshold.value;
});
dSmoothing.addEventListener('input', () => {
  const v = dSmoothing.value / 100;
  if (analyser) analyser.smoothingTimeConstant = v;
  dSmoothingVal.textContent = v.toFixed(2);
});
dFFT.addEventListener('change', () => {
  currentFFTSize = parseInt(dFFT.value);
  rebuildAnalyser();
});
dGain.addEventListener('input', () => {
  visualGain = dGain.value / 100;
  dGainVal.textContent = visualGain.toFixed(1) + '\u00d7';
});
dLog.addEventListener('click', () => {
  logFreqAxis = !logFreqAxis;
  dLog.classList.toggle('active', logFreqAxis);
  buildBars();
});

// Band solo — click toggles solo mode, then click on bars to select range
let soloActive = false;
dSolo.addEventListener('click', () => {
  soloActive = !soloActive;
  soloMode = soloActive;
  dSolo.classList.toggle('active', soloActive);
  if (!soloActive) {
    soloRange = [0, 1];  // reset to show all
  }
});

// Click on canvas to select solo range
renderer.domElement.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!soloActive) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const normX = (e.clientX - rect.left) / rect.width;
  const clickBin = Math.floor(normX * binCount);
  const halfRange = Math.max(2, Math.floor(binCount * 0.08));
  const lo = Math.max(0, clickBin - halfRange) / binCount;
  const hi = Math.min(binCount, clickBin + halfRange) / binCount;
  soloRange = [lo, hi];
});

// ── Animation loop ──
function animate() {
  requestAnimationFrame(animate);

  if (!analyser || !dataArray) {
    renderer.render(scene, camera);
    return;
  }

  analyser.getByteFrequencyData(dataArray);

  // Also write to frequencyUniform (first 64 bins for SCENE compat)
  for (let i = 0; i < 64 && i < binCount; i++) {
    frequencyUniform[i] = dataArray[i];
  }

  const margin = 0.04;
  const totalWidth = 2.0 - margin * 2;
  const barMaxHeight = 1.5;
  const baseY = -0.85;
  const gate = threshold * 0.25;

  for (let i = 0; i < binCount && i < rawBars.length; i++) {
    const raw = dataArray[i] / 255;
    const gatedAmp = Math.max(raw - gate, 0) / Math.max(1.0 - gate, 0.01);
    const normIdx = i / Math.max(binCount - 1, 1);

    // Solo masking
    let mask = 1;
    if (soloMode) {
      mask = (normIdx >= soloRange[0] && normIdx <= soloRange[1]) ? 1 : 0.05;
    }

    // Raw bar height
    const rawH = raw * visualGain * barMaxHeight * mask;
    const clampedRawH = Math.max(rawH, 0.001);
    rawBars[i].scale.y = clampedRawH;
    rawBars[i].position.y = baseY + clampedRawH / 2;
    rawBars[i].material.opacity = 0.35 * mask;

    // Gated bar height
    const gH = gatedAmp * visualGain * barMaxHeight * mask;
    const clampedGH = Math.max(gH, 0.001);
    gatedBars[i].scale.y = clampedGH;
    gatedBars[i].position.y = baseY + clampedGH / 2;
    gatedBars[i].material.opacity = 0.85 * mask;

    // Peak hold
    const displayVal = gatedAmp * visualGain * mask;
    if (displayVal > peakValues[i]) {
      peakValues[i] = displayVal;
    } else {
      peakValues[i] *= peakDecay;
    }
    const peakY = baseY + peakValues[i] * barMaxHeight;
    peakDots[i].position.y = peakY;
    peakDots[i].material.opacity = Math.min(peakValues[i] * 2, 0.7) * mask;
  }

  renderer.render(scene, camera);
}

// ── Resize ──
window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  buildLabels();
});

// ── Init ──
buildBars();
buildGrid();
animate();

// ── window.SCENE export — minimal contract for mic-input.js ──
window.SCENE = {
  scene, camera, renderer,
  uniforms: {},
  frequencyUniform,
  get particles() { return barGroup; },
  get seedCenter() { return {}; },
  get rotSpeedY() { return 0; },
  get rotSpeedX() { return 0; },
  get bakedArcScale() { return 0; },
  get bakedDriftScale() { return 0; },
  driftCycles: {}, DRIFT_BASE: 240, uniformMap: {},
  rotXMult: 0, rotDriftScale: 0, tiltDriftScale: 0,
  storyArc: () => ({}),
  get currentBuffer() { return currentBuffer; },
  get audioDuration() { return audioDuration; },
  get audioContext() { return audioContext; },
  get analyser() { return analyser; },
  get playState() { return playState; },
  ensureAudio,
  applyAndLaunch,
  setPlayState(v) {
    playState = v;
    if (v === 'listening') diagBar.classList.add('active');
    if (v === 'idle') diagBar.classList.remove('active');
  },
  stopFileAudio() {
    if (source) { source.onended = null; try { source.stop(); } catch(e) {} source.disconnect(); source = null; }
  },
  vjApply() {},
  set vjActive(v) {},
  get vjActive() { return false; },
  get currentFileName() { return currentFileName; },
  sceneName: 'spectrum'
};

/* ── Audio cleanup on page lifecycle (iOS BFCache fix) ── */
window.addEventListener('pagehide', function () {
  if (source) { source.onended = null; try { source.stop(); } catch(e) {} source.disconnect(); source = null; }
  if (audioContext) { try { audioContext.close(); } catch(e) {} }
  playState = 'idle';
});
window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
document.addEventListener('visibilitychange', function () {
  if (!audioContext) return;
  if (document.hidden) { if (playState === 'playing') audioContext.suspend(); }
  else { if (playState === 'playing') audioContext.resume(); }
});
