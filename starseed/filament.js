const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uTension;
  uniform float uWeave;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uSpan;
  uniform float uThreshold;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aStrand;
  attribute float aAlong;
  attribute float aPhase;
  varying float vStrand;
  varying float vFreqAmp;
  varying float vAlong;

  void main() {
    // Each strand reads from multiple frequency bins for chaotic interference
    float normStrand = aStrand * uSpan;
    int idx = int(clamp(floor(normStrand * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(normStrand * 63.0 + 7.0), 0.0, 63.0));
    int idx3 = int(clamp(floor((1.0 - normStrand) * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;
    float amp3 = uFrequencyData[idx3] / 255.0;

    // Gate
    float gate = uThreshold * 0.3;
    float gatedAmp = max(amp - gate, 0.0) / max(1.0 - gate, 0.01);
    float gatedAmp2 = max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01);
    float gatedAmp3 = max(amp3 - gate, 0.0) / max(1.0 - gate, 0.01);

    // Layered chaotic wave interference — not bouncy sine, jagged and overlapping
    float t = uTime;
    float a = aAlong * 6.28;
    float p1 = aPhase;
    // Primary wave: sharp sawtooth-ish via layered harmonics
    float w1 = sin(a * uPulseFreq + t * uPulseSpeed * 1.3 + p1) * 0.5
             + sin(a * uPulseFreq * 2.1 - t * uPulseSpeed * 0.9 + p1 * 1.7) * 0.3
             + sin(a * uPulseFreq * 3.7 + t * uPulseSpeed * 2.1) * 0.2;
    // Cross-strand interference: neighboring strands modulate each other
    float w2 = sin(a * uPulseFreq * 1.4 + t * uPulseSpeed * 0.6 - aStrand * 11.0) * 0.4
             + sin(a * uPulseFreq * 0.7 + t * uPulseSpeed * 1.8 + aStrand * 7.3) * 0.3
             + cos(a * uPulseFreq * 2.9 - t * uPulseSpeed * 1.1 + p1 * 2.3) * 0.3;
    // Noise-like high-freq jitter driven by treble
    float jitter = sin(a * 17.0 + t * 5.0 + p1 * 3.0) * gatedAmp3 * 0.15;

    vec3 newPos = position;
    // Chaotic Y displacement: layered waves, not a single bounce
    float yDisp = w1 * uWeave * (0.15 + gatedAmp * 0.85) * 0.4
                + w2 * uWeave * gatedAmp2 * 0.2
                + jitter;
    newPos.y += yDisp;
    // Z chaos: cross-frequency interference
    newPos.z += w2 * uWeave * gatedAmp * 0.18 + jitter * 0.5;
    // Tension: sharp transverse snap, not gentle sag
    float snap = gatedAmp * uTension * 0.3 * (w1 * 0.7 + w2 * 0.3);
    newPos.y += snap;
    // X micro-turbulence
    newPos.x += sin(t * 3.7 + p1 * 5.0 + aStrand * 3.0) * gatedAmp * 0.03;

    vStrand = aStrand;
    vFreqAmp = gatedAmp;
    vAlong = aAlong;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Tiny points — reads as wave lines, not particles
    float baseSize = 0.6;
    gl_PointSize = (baseSize + gatedAmp * 1.0) * (160.0 / -mvPos.z) * step(0.003, gatedAmp) + 0.5;

    // Viewport constraint
    vec4 clipPos = projectionMatrix * mvPos;
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 pointRadiusNDC = vec2(gl_PointSize) / uViewport;
    vec2 maxNDC = max(vec2(1.0) - pointRadiusNDC, vec2(0.0));
    if (uBoundary > 0.5) {
    vec2 clamped = clamp(ndc, -maxNDC, maxNDC);
    vec2 overflow = ndc - clamped;
    ndc = clamped - overflow * 0.4;
    }
    clipPos.xy = ndc * clipPos.w;
    gl_Position = clipPos;
  }
`;

const fragmentShader = `
  varying float vStrand;
  varying float vFreqAmp;
  varying float vAlong;
  uniform float uHue;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Razor sharp core — near-pixel edge
    float alpha = 1.0 - smoothstep(0.05, 0.28, dist);
    // Barely-there halo
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.04;

    // Cool/warm palette via uHue — strand position gives variety
    vec3 cool1 = vec3(0.20, 0.50, 0.90);
    vec3 cool2 = vec3(0.40, 0.75, 0.85);
    vec3 warm1 = vec3(0.85, 0.40, 0.20);
    vec3 warm2 = vec3(0.95, 0.70, 0.30);

    vec3 base1 = mix(cool1, warm1, uHue);
    vec3 base2 = mix(cool2, warm2, uHue);

    // Color varies along strand and by frequency
    vec3 color = mix(base1, base2, vAlong);
    // Audio brightens — sharper white flash
    color = mix(color, vec3(1.0), vFreqAmp * 0.65);

    // High alpha — reads as solid wave line
    alpha *= 0.82 + vFreqAmp * 0.18;
    alpha += halo;

    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime: { value: 0.0 },
  uTension: { value: 1.2 },
  uWeave: { value: 1.0 },
  uPulseFreq: { value: 3.0 },
  uPulseSpeed: { value: 2.0 },
  uSpan: { value: 0.7 },
  uHue: { value: 0.5 },
  uThreshold: { value: 0.5 },
  uViewport: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uBoundary:  { value: 1.0 }
};

const sliders = {
  p1: document.getElementById('p1'),
  p2: document.getElementById('p2'),
  p3: document.getElementById('p3'),
  p4: document.getElementById('p4'),
  p5: document.getElementById('p5'),
  p6: document.getElementById('p6'),
  p7: document.getElementById('p7'),
  p8: document.getElementById('p8')
};
const valDisplays = {
  p1: document.getElementById('p1-val'),
  p2: document.getElementById('p2-val'),
  p3: document.getElementById('p3-val'),
  p4: document.getElementById('p4-val'),
  p5: document.getElementById('p5-val'),
  p6: document.getElementById('p6-val'),
  p7: document.getElementById('p7-val'),
  p8: document.getElementById('p8-val')
};

function randomizeSliders() {
  Object.keys(sliders).forEach(k => {
    const s = sliders[k];
    const v = Math.floor(+s.min + Math.random() * (+s.max - +s.min));
    s.value = v;
    valDisplays[k].textContent = v;
  });
}

Object.keys(sliders).forEach(k => {
  sliders[k].addEventListener('input', () => {
    valDisplays[k].textContent = sliders[k].value;
  });
});
randomizeSliders();

const randomizeBtn = document.getElementById('randomize-btn');
if (randomizeBtn) randomizeBtn.addEventListener('click', randomizeSliders);

function computeSeedValues() {
  const tension = sliders.p1.value / 100;
  const weave   = sliders.p2.value / 100;
  const density = sliders.p3.value / 100;
  const speed   = sliders.p4.value / 100;

  const effectiveTension = tension * (1.0 + speed * 0.3);
  const effectiveWeave = weave * (1.0 - tension * 0.2);

  return {
    tension: 0.3 + effectiveTension * 2.5,
    weave: 0.2 + effectiveWeave * 2.0,
    pulseFreq: 1.0 + weave * 5.0,
    pulseSpeed: 0.5 + speed * 4.0,
    span: 0.4 + density * 0.6,
    rotSpeedY: 0.01 + weave * 0.08,
    rotSpeedX: 0.005 + weave * 0.04,
    smoothing: 0.92 - speed * 0.6,
    detail: Math.floor(4 + density * 35),
    hue: sliders.p5.value / 100,
    arc: sliders.p6.value / 100,
    threshold: sliders.p7.value / 100,
    drift: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  // More strands, much denser points — reads as continuous wave lines
  const strands = Math.floor(14 + detail * 0.8);
  const positions = [];
  const strandAttrs = [];
  const alongAttrs = [];
  const phaseAttrs = [];

  for (let s = 0; s < strands; s++) {
    const strandNorm = s / (strands - 1);
    // Distribute across Y and Z with chaotic offsets
    const startY = (strandNorm - 0.5) * 3.8 + Math.sin(s * 3.7) * 0.3;
    const startZ = Math.sin(s * 2.39996) * 0.9 + Math.cos(s * 1.17) * 0.4;
    // Varied angles — not all horizontal, some tilted
    const tiltY = (Math.sin(s * 1.618) * 0.5) * 0.6;
    const tiltZ = (Math.cos(s * 2.71) * 0.5) * 0.3;

    // Dense sampling — 3x more points for wave continuity
    const ptsPerStrand = Math.floor(60 + detail * 1.8);
    for (let p = 0; p < ptsPerStrand; p++) {
      const along = p / (ptsPerStrand - 1);
      // Strand extends with tilt variation
      const x = (along - 0.5) * 5.5;
      const y = startY + along * tiltY;
      const z = startZ + along * tiltZ;
      // Micro-jitter — very small, preserves wave line
      const jx = (Math.random() - 0.5) * 0.008;
      const jy = (Math.random() - 0.5) * 0.008;
      const jz = (Math.random() - 0.5) * 0.008;
      positions.push(x + jx, y + jy, z + jz);
      strandAttrs.push(strandNorm);
      alongAttrs.push(along);
      phaseAttrs.push(Math.random() * Math.PI * 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aStrand', new THREE.Float32BufferAttribute(strandAttrs, 1));
  geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(alongAttrs, 1));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phaseAttrs, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  particles = new THREE.Points(geometry, material);
  scene.add(particles);
}
buildParticles(18);

let rotSpeedY = 0.05;
let rotSpeedX = 0.03;
let bakedArc = 0.5;
let bakedDrift = 0.5;
let seedCenter = {
  tension: 1.2,
  weave: 1.0,
  pulseFreq: 3.0,
  pulseSpeed: 2.0,
  span: 0.7
};

let audioContext = null;
let analyser = null;
let dataArray = null;
const _smoothedFreq = new Float32Array(64);
let _sceneSm = 0.85;
const _bassSm = 0.05;
let source = null;
let audioDuration = 0;
let audioStartTime = 0;

function initAudio(smoothing) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0; _sceneSm = smoothing;
  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

let currentBuffer = null, currentFileName = '';
let playState = 'idle';
let _vjActive = false;
let _lastGeoKey = '';
const fileInput = document.getElementById('file-input');
const playBtn = document.getElementById('play-btn');
const controlsEl = document.getElementById('controls');

function showAudioReady() {
  document.getElementById('upload-area').style.display = 'none';
  document.getElementById('audio-ready').style.display = 'block';
  document.getElementById('audio-name').textContent = currentFileName;
  playBtn.textContent = '\u25b6\uFE0E Play';
  playState = 'idle';
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  currentFileName = file.name;
  if (!audioContext) initAudio(0.85);
  const reader = new FileReader();
  reader.onload = (evt) => {
    const raw = evt.target.result;
    audioContext.decodeAudioData(raw.slice(0), (buffer) => {
      currentBuffer = buffer;
      audioDuration = buffer.duration;
      showAudioReady();
      AudioStore.save(raw, currentFileName);
    });
  };
  reader.readAsArrayBuffer(file);
});

AudioStore.load().then(data => {
  if (!data) return;
  currentFileName = data.name;
  if (!audioContext) initAudio(0.85);
  audioContext.decodeAudioData(data.buffer, (buffer) => {
    currentBuffer = buffer;
    audioDuration = buffer.duration;
    showAudioReady();
  });
}).catch(() => {});

function ensureAudio() {
  if (!audioContext) initAudio(0.85);
  return { audioContext, analyser, dataArray };
}

function applyAndLaunch() {
  _initDriftPhases();
  if (playState === 'listening' && window.SCENE && window.SCENE._stopMic) window.SCENE._stopMic();
  const seeds = computeSeedValues();
  controlsEl.classList.add('hidden'); controlsEl.classList.remove('visible');

  uniforms.uTension.value = seeds.tension;
  uniforms.uWeave.value = seeds.weave;
  uniforms.uPulseFreq.value = seeds.pulseFreq;
  uniforms.uPulseSpeed.value = seeds.pulseSpeed;
  uniforms.uSpan.value = seeds.span;
  uniforms.uHue.value = seeds.hue;
  uniforms.uThreshold.value = seeds.threshold;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    tension: seeds.tension,
    weave: seeds.weave,
    pulseFreq: seeds.pulseFreq,
    pulseSpeed: seeds.pulseSpeed,
    span: seeds.span
  };
  bakedArc = seeds.arc;
  bakedDrift = seeds.drift;
  buildParticles(seeds.detail);
  _lastGeoKey = String(seeds.detail);
  _sceneSm = seeds.smoothing;
}

playBtn.addEventListener('click', () => {
  if (!currentBuffer) return;
  applyAndLaunch();

  if (playState === 'paused') {
    audioContext.resume();
    playState = 'playing';
    return;
  }

  if (source) { source.onended = null; try { source.stop(); } catch(e){} source.disconnect(); }
  source = audioContext.createBufferSource();
  source.buffer = currentBuffer;
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  if (audioContext.state === 'suspended') audioContext.resume();
  source.start(0);
  audioStartTime = audioContext.currentTime;
  playState = 'playing';
  source.onended = () => {
    playState = 'idle';
    playBtn.textContent = '\u25b6\uFE0E Play';
    controlsEl.classList.remove('hidden');
  };
});

document.getElementById('replace-btn').addEventListener('click', () => {
  fileInput.click();
});

renderer.domElement.addEventListener('click', () => {
  if (playState === 'playing') {
    audioContext.suspend();
    playState = 'paused';
    playBtn.textContent = '\u25b6\uFE0E Resume';
    controlsEl.classList.add('visible');
    controlsEl.classList.remove('hidden');
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  uniforms.uViewport.value.set(window.innerWidth, window.innerHeight);
});

// Act I:   Dim (0-15%)        — faint threads barely visible
// Act II:  Ignite (15-40%)    — strands light up, tension builds
// Act III: Surge (40-60%)     — maximum displacement, bright pulses
// Act IV:  Ebb (60-82%)       — softening, strands settle
// Act V:   Trace (82-100%)    — ghostly afterimages, near silence
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const sm = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x-e0)/(e1-e0))); return t*t*(3-2*t); };

  return {
    tension:   Math.max(0.1, 0.3 + 0.3*sm(0,0.15,p) + 0.5*sm(0.15,0.45,p) - 0.2*sm(0.6,0.82,p) - 0.5*sm(0.82,1,p)),
    weave:     Math.max(0.05, 0.2 + 0.2*sm(0.05,0.2,p) + 0.6*sm(0.2,0.5,p) - 0.3*sm(0.6,0.8,p) - 0.4*sm(0.85,1,p)),
    pulseFreq: Math.max(0.3, 0.5 + 0.15*sm(0.1,0.3,p) + 0.4*sm(0.3,0.5,p) - 0.2*sm(0.65,0.85,p) - 0.3*sm(0.88,1,p)),
    pulseSpeed:Math.max(0.15, 0.4 + 0.25*sm(0.1,0.25,p) + 0.5*sm(0.25,0.5,p) - 0.15*sm(0.55,0.7,p) - 0.6*sm(0.82,1,p)),
    span:      Math.max(0.2, 0.5 + 0.15*sm(0.05,0.2,p) + 0.35*sm(0.2,0.5,p) - 0.1*sm(0.6,0.75,p) - 0.4*sm(0.8,1,p)),
    rot:       Math.max(0.1, 0.5 + 0.2*sm(0.1,0.3,p) + 0.4*sm(0.3,0.55,p) - 0.3*sm(0.7,0.9,p) - 0.4*sm(0.9,1,p))
  };
}

const clock = new THREE.Clock();
const DRIFT_BASE = 108;
const driftCycles = {
  tension:   { period: DRIFT_BASE * 1.000, depth: 0.30 },
  weave:     { period: DRIFT_BASE * 0.786, depth: 0.35 },
  pulseFreq: { period: DRIFT_BASE * 1.272, depth: 0.25 },
  pulseSpeed:{ period: DRIFT_BASE * 0.618, depth: 0.30 },
  span:      { period: DRIFT_BASE * 1.618, depth: 0.20 },
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { tension: 1, weave: 1, pulseFreq: 1, pulseSpeed: 1, span: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const progress = Math.min((audioContext.currentTime - audioStartTime) / audioDuration, 1.0);
    const rawArc = storyArc(progress);
    for (const k in rawArc) arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedArc;
  }

  const TWO_PI = Math.PI * 2;
  const uNameMap = { tension: 'uTension', weave: 'uWeave', pulseFreq: 'uPulseFreq', pulseSpeed: 'uPulseSpeed', span: 'uSpan' };
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedDrift * 1.4);
    const phase1 = Math.sin(dt * TWO_PI / period + (_dp[key] || 0));
    const phase2 = Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0));
    const drift = (phase1 * 0.65 + phase2 * 0.35) * scaledDepth;
    uniforms[uNameMap[key]].value = Math.max(0.01, seedCenter[key] * (arcMult[key] || 1) * (1.0 + drift));
  }

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.1;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.06;

  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < 64; i++) {
      const a = i < 2 ? _bassSm : _sceneSm;
      _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i];
      frequencyUniform[i] = _smoothedFreq[i];
    }
  }

  particles.rotation.y = elapsed * rotSpeedY * (arcMult.rot || 1) * (1.0 + rotDrift);
  particles.rotation.x = elapsed * rotSpeedX * 0.3 * (arcMult.rot || 1) * (1.0 + tiltDrift);

  renderer.render(scene, camera);
}

function _vjApply() {
  const seeds = computeSeedValues();
  uniforms.uTension.value = seeds.tension;
  uniforms.uWeave.value = seeds.weave;
  uniforms.uPulseFreq.value = seeds.pulseFreq;
  uniforms.uPulseSpeed.value = seeds.pulseSpeed;
  uniforms.uSpan.value = seeds.span;
  uniforms.uHue.value = seeds.hue;
  uniforms.uThreshold.value = seeds.threshold;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { tension: seeds.tension, weave: seeds.weave, pulseFreq: seeds.pulseFreq, pulseSpeed: seeds.pulseSpeed, span: seeds.span };
  bakedArc = seeds.arc;
  bakedDrift = seeds.drift;
  const gk = String(seeds.detail);
  if (gk !== _lastGeoKey) { buildParticles(seeds.detail); _lastGeoKey = gk; }
  _sceneSm = seeds.smoothing;
}

window.SCENE = {
  scene, camera, renderer, uniforms, frequencyUniform, _bassSm, get _sceneSm() { return _sceneSm; },
  get particles() { return particles; },
  get seedCenter() { return seedCenter; },
  get rotSpeedY() { return rotSpeedY; },
  get rotSpeedX() { return rotSpeedX; },
  get bakedArcScale() { return bakedArc; },
  get bakedDriftScale() { return bakedDrift; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap: { tension:'uTension', weave:'uWeave', pulseFreq:'uPulseFreq', pulseSpeed:'uPulseSpeed', span:'uSpan' },
  rotXMult: 0.3, rotDriftScale: 0.1, tiltDriftScale: 0.06,
  storyArc,
  get currentBuffer() { return currentBuffer; },
  get audioDuration() { return audioDuration; },
  get audioContext() { return audioContext; },
  get analyser() { return analyser; },
  get playState() { return playState; },
  ensureAudio,
  applyAndLaunch,
  setPlayState(v) { playState = v; },
  stopFileAudio() { if (source) { source.onended = null; try { source.stop(); } catch(e) {} source.disconnect(); source = null; } },
  vjApply() { _vjApply(); },
  set vjActive(v) { _vjActive = v; },
  get vjActive() { return _vjActive; },
  get currentFileName() { return currentFileName; },
  sceneName: 'filament'
};

animate();

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
