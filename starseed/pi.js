const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uConvergence;
  uniform float uHarmonic;
  uniform float uSeries;
  uniform float uEuler;
  uniform float uThreshold;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aRing;
  attribute float aTheta;
  attribute float aPhase;
  varying float vRing;
  varying float vFreqAmp;
  varying float vTheta;
  varying float vMorph;

  #define PI  3.14159265358979
  #define TAU 6.28318530717959

  void main() {
    // Frequency: inner rings = bass, outer = treble
    int idx  = int(clamp(floor(aRing * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor((1.0 - aRing) * 63.0), 0.0, 63.0));
    int idx3 = int(clamp(floor(aTheta / TAU * 63.0), 0.0, 63.0));
    float amp  = uFrequencyData[idx]  / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;
    float amp3 = uFrequencyData[idx3] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp  = max(amp  - gate, 0.0) / max(1.0 - gate, 0.01);
    float gAmp2 = max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01);
    float gAmp3 = max(amp3 - gate, 0.0) / max(1.0 - gate, 0.01);

    float theta = aTheta;
    float baseR = 0.3 + aRing * 1.5;

    float phaseShift = uEuler * PI * sin(uTime * 0.25 + aRing * PI) * (0.2 + gAmp * 0.8);
    theta += phaseShift;

    // === MORPH 1: Archimedes inscribed polygon ===
    // π ≈ n·sin(π/n) — more sides converge to the circle
    float n = 3.0 + uConvergence * 47.0;
    float sector = TAU / n;
    float sTheta = mod(theta + sector * 0.5, sector) - sector * 0.5;
    float polyR = baseR * cos(PI / n) / cos(sTheta);

    // === MORPH 2: Rose curve r = 1 + a·cos(k·θ) ===
    float petals = floor(2.0 + uHarmonic * 7.0);
    float roseR = baseR * (0.65 + 0.35 * cos(petals * theta + uTime * 0.35));

    // === MORPH 3: Fourier / Leibniz series ===
    // π/4 = Σ (-1)^k / (2k+1) — each term adds a harmonic
    float fourierR = baseR;
    float depth = 1.0 + uSeries * 6.0;
    for (float k = 1.0; k <= 7.0; k += 1.0) {
      float w = step(k, depth);
      float sign = 1.0 - 2.0 * mod(k, 2.0);
      float weight = sign / (2.0 * k + 1.0);
      fourierR += w * baseR * weight * 0.35
                * sin(k * theta + uTime * k * 0.18)
                * (0.3 + gAmp * 0.7);
    }

    // === Audio-driven morph blend ===
    // Bass → polygon deformation, Mids → rose, Treble → Fourier
    float mPoly    = gAmp  * (1.0 - aRing) + 0.05;
    float mRose    = gAmp2 * 0.8 + 0.05;
    float mFourier = gAmp3 * aRing + 0.05;
    float mBase    = 0.08;
    float total    = mPoly + mRose + mFourier + mBase;

    float radius = (polyR * mPoly + roseR * mRose + fourierR * mFourier + baseR * mBase) / total;

    // Archimedean spiral breathing
    float spiral = sin(uTime * 0.12 + aRing * TAU) * 0.06 * (0.4 + gAmp * 0.6);
    radius += spiral;

    // Position from polar
    float x = cos(theta) * radius;
    float y = sin(theta) * radius;
    // Z: rings at slightly different depths + audio ripple
    float z = (aRing - 0.5) * 0.6 + sin(theta * 2.0 + uTime * 0.25) * gAmp * 0.12;

    vRing = aRing;
    vFreqAmp = gAmp;
    vTheta = aTheta;
    vMorph = (mPoly + mRose + mFourier) / total;

    vec4 mvPos = modelViewMatrix * vec4(x, y, z, 1.0);

    float baseSize = 1.1;
    gl_PointSize = (baseSize + gAmp * 2.2) * (230.0 / -mvPos.z) * step(0.003, gAmp) + 0.7;

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
  varying float vRing;
  varying float vFreqAmp;
  varying float vTheta;
  varying float vMorph;
  uniform float uIrrational;
  uniform float uTime;

  #define PI  3.14159265358979
  #define TAU 6.28318530717959
  // First 20 digits of π as a subtle visual fingerprint
  #define PI_DIGITS 3.14159265358979323846

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Morphing softness — not razor-sharp, slightly organic for the transformation feel
    float alpha = 1.0 - smoothstep(0.08, 0.42, dist);
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.06;

    // Phase-cycling spectral color — θ walks around 2π
    // Shifted by uIrrational * golden ratio (irrational offset = never repeats, like π)
    float phase = vTheta / TAU + uIrrational * 1.6180339887 + vRing * 0.4 + uTime * 0.015;

    // Smooth HSV-like cycle: 0.5 + 0.5 * cos(2π(phase + offset))
    vec3 color = 0.5 + 0.5 * cos(TAU * (phase + vec3(0.0, 0.33, 0.67)));

    // Pull toward a mathematical coolness — indigo/silver undertone
    color = mix(color, vec3(0.65, 0.68, 0.85), 0.25);

    // Morph intensity slightly shifts hue
    color = mix(color, vec3(0.9, 0.8, 1.0), vMorph * 0.15);

    // Audio drives toward white
    color = mix(color, vec3(1.0), vFreqAmp * 0.55);

    alpha *= 0.5 + vFreqAmp * 0.5;
    alpha += halo;

    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 4.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime:        { value: 0.0 },
  uConvergence: { value: 0.5 },
  uHarmonic:    { value: 0.5 },
  uSeries:      { value: 0.5 },
  uEuler:       { value: 0.6 },
  uIrrational:  { value: 0.5 },
  uThreshold:   { value: 0.5 },
  uViewport:    { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
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
  const convergence = sliders.p1.value / 100;
  const harmonic    = sliders.p2.value / 100;
  const series      = sliders.p3.value / 100;
  const euler       = sliders.p4.value / 100;

  // Series depth amplifies convergence (more terms → smoother polygon)
  const effectiveConvergence = convergence * (1.0 + series * 0.3);
  // Euler phase dampened by high harmonic (complex rose absorbs rotation)
  const effectiveEuler = euler * (1.0 - harmonic * 0.2);

  return {
    convergence: 0.05 + effectiveConvergence * 0.95,
    harmonic:    0.1 + harmonic * 0.9,
    series:      0.1 + series * 0.9,
    euler:       0.1 + effectiveEuler * 1.5,
    rotSpeedY:   0.008 + euler * 0.04,
    rotSpeedX:   0.004 + euler * 0.02,
    smoothing:   0.88 - harmonic * 0.4,
    detail:      Math.floor(6 + convergence * 30),
    irrational:  sliders.p5.value / 100,
    epoch:       sliders.p6.value / 100,
    threshold:   sliders.p7.value / 100,
    flux:        sliders.p8.value / 100
  };
}

// Positions are set to base circle but are fully overridden in vertex shader
let particles;
function buildParticles(detail) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  const rings = Math.floor(8 + detail * 0.5);
  const positions = [];
  const ringAttrs = [];
  const thetaAttrs = [];
  const phaseAttrs = [];

  for (let r = 0; r < rings; r++) {
    const ringNorm = r / (rings - 1);
    const baseRadius = 0.3 + ringNorm * 1.5;
    // Outer rings get more points for density
    const ptsOnRing = Math.floor((40 + detail * 1.6) * (0.5 + ringNorm * 0.5));

    for (let p = 0; p < ptsOnRing; p++) {
      const theta = (p / ptsOnRing) * Math.PI * 2;
      // Base circle positions (shader overrides these entirely)
      positions.push(
        Math.cos(theta) * baseRadius,
        Math.sin(theta) * baseRadius,
        (ringNorm - 0.5) * 0.6
      );
      ringAttrs.push(ringNorm);
      thetaAttrs.push(theta);
      phaseAttrs.push(Math.random() * Math.PI * 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aRing', new THREE.Float32BufferAttribute(ringAttrs, 1));
  geometry.setAttribute('aTheta', new THREE.Float32BufferAttribute(thetaAttrs, 1));
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

let rotSpeedY = 0.02;
let rotSpeedX = 0.01;
let bakedEpoch = 0.5;
let bakedFlux = 0.5;
let seedCenter = {
  convergence: 0.5,
  harmonic: 0.5,
  series: 0.5,
  euler: 0.6
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

  uniforms.uConvergence.value = seeds.convergence;
  uniforms.uHarmonic.value    = seeds.harmonic;
  uniforms.uSeries.value      = seeds.series;
  uniforms.uEuler.value       = seeds.euler;
  uniforms.uIrrational.value  = seeds.irrational;
  uniforms.uThreshold.value   = seeds.threshold;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    convergence: seeds.convergence,
    harmonic:    seeds.harmonic,
    series:      seeds.series,
    euler:       seeds.euler
  };
  bakedEpoch = seeds.epoch;
  bakedFlux  = seeds.flux;
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

// Act I:   Point (0-12%)       — a dot, pure potential, the origin
// Act II:  Inscribe (12-35%)   — polygon emerges, sides multiplying, π approximated
// Act III: Transcend (35-60%)  — full morph chaos, all forms superimposed
// Act IV:  Converge (60-82%)   — series terms accumulate, shapes resolve toward circle
// Act V:   ∞ (82-100%)        — perfect circle collapsing to a point, π achieved
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const sm = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  // Convergence: starts low (triangle), peaks mid, very high at end
  const convArc = 0.05
    + 0.15 * sm(0.0, 0.12, p)
    + 0.3  * sm(0.12, 0.35, p)
    + 0.2  * sm(0.35, 0.6, p)
    + 0.4  * sm(0.6, 0.82, p)
    - 0.1  * sm(0.88, 1.0, p);

  // Harmonic: emerges in act II, peaks in III
  const harmArc = 0.1
    + 0.2  * sm(0.1, 0.25, p)
    + 0.6  * sm(0.25, 0.5, p)
    + 0.15 * sm(0.5, 0.6, p)
    - 0.25 * sm(0.65, 0.82, p)
    - 0.4  * sm(0.85, 1.0, p);

  // Series: slow build, peaks in act IV (convergence of the series)
  const seriesArc = 0.1
    + 0.1  * sm(0.05, 0.2, p)
    + 0.3  * sm(0.2, 0.4, p)
    + 0.4  * sm(0.4, 0.65, p)
    + 0.15 * sm(0.65, 0.82, p)
    - 0.6  * sm(0.85, 1.0, p);

  // Euler phase: builds slowly, peaks in transcendence
  const eulerArc = 0.2
    + 0.15 * sm(0.1, 0.3, p)
    + 0.5  * sm(0.3, 0.55, p)
    + 0.2  * sm(0.55, 0.65, p)
    - 0.3  * sm(0.7, 0.85, p)
    - 0.4  * sm(0.88, 1.0, p);

  const rotArc = 0.2
    + 0.2  * sm(0.1, 0.3, p)
    + 0.6  * sm(0.3, 0.6, p)
    - 0.2  * sm(0.7, 0.85, p)
    - 0.4  * sm(0.88, 1.0, p);

  return {
    convergence: Math.max(0.05, convArc),
    harmonic:    Math.max(0.05, harmArc),
    series:      Math.max(0.05, seriesArc),
    euler:       Math.max(0.05, eulerArc),
    rot:         Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();
const DRIFT_BASE = 108;
const driftCycles = {
  convergence: { period: DRIFT_BASE * 1.000, depth: 0.30 },
  harmonic:    { period: DRIFT_BASE * 0.786, depth: 0.35 },
  series:      { period: DRIFT_BASE * 1.272, depth: 0.25 },
  euler:       { period: DRIFT_BASE * 0.618, depth: 0.30 },
};
const uniformMap = {
  convergence: 'uConvergence',
  harmonic:    'uHarmonic',
  series:      'uSeries',
  euler:       'uEuler'
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { convergence: 1, harmonic: 1, series: 1, euler: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const progress = Math.min((audioContext.currentTime - audioStartTime) / audioDuration, 1.0);
    const rawArc = storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedEpoch;
    }
  }

  const TWO_PI = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedFlux * 1.4);
    const phase1 = Math.sin(dt * TWO_PI / period + (_dp[key] || 0));
    const phase2 = Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0));
    const drift = (phase1 * 0.65 + phase2 * 0.35) * scaledDepth;
    const arcVal = arcMult[key] || 1;
    const uName = uniformMap[key];
    if (uName && uniforms[uName]) {
      uniforms[uName].value = Math.max(0.01, seedCenter[key] * arcVal * (1.0 + drift));
    }
  }

  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < 64; i++) {
      const a = i < 2 ? _bassSm : _sceneSm;
      _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i];
      frequencyUniform[i] = _smoothedFreq[i];
    }
  }

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.04;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.02;

  const driftAmt = 0.08 * (0.4 + bakedFlux * 0.8);
  particles.position.x = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.4) + (_dp._px || 0)) * driftAmt;
  particles.position.y = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.0) + 1.7 + (_dp._py || 0)) * driftAmt * 0.7;
  const breathe = 1.0 + Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.8) + (_dp._br || 0)) * 0.05 * (arcMult.rot || 1);
  particles.scale.setScalar(breathe);

  particles.rotation.y = elapsed * rotSpeedY * (arcMult.rot || 1) * (1.0 + rotDrift) * 0.2;
  particles.rotation.x = elapsed * rotSpeedX * 0.4 * (arcMult.rot || 1) * (1.0 + tiltDrift) * 0.2;

  renderer.render(scene, camera);
}

function _vjApply() {
  const seeds = computeSeedValues();
  uniforms.uConvergence.value = seeds.convergence;
  uniforms.uHarmonic.value = seeds.harmonic;
  uniforms.uSeries.value = seeds.series;
  uniforms.uEuler.value = seeds.euler;
  uniforms.uIrrational.value = seeds.irrational;
  uniforms.uThreshold.value = seeds.threshold;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { convergence: seeds.convergence, harmonic: seeds.harmonic, series: seeds.series, euler: seeds.euler };
  bakedEpoch = seeds.epoch;
  bakedFlux = seeds.flux;
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
  get bakedArcScale() { return bakedEpoch; },
  get bakedDriftScale() { return bakedFlux; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap,
  rotXMult: 0.08, rotDriftScale: 0.04, tiltDriftScale: 0.02,
  rotYMult: 0.2, posDrift: { amt: 0.08, px: 1.4, py: 1.0, ys: 0.7 }, breathe: { period: 1.8, amp: 0.05 },
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
  sceneName: 'pi'
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
