const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uPulse;
  uniform float uCurrent;
  uniform float uDilation;
  uniform float uStrata;
  uniform float uDecay;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aLayer;
  attribute float aSpread;
  attribute float aPhase;
  varying float vLayer;
  varying float vFreqAmp;
  varying float vDepth;

  void main() {
    // Each shell reads from frequency bins — inner shells = bass, outer = treble
    float normLayer = aLayer * uStrata;
    int idx = int(clamp(floor(normLayer * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Gate quiet signals
    float gate = uDecay * 0.25 + (1.0 - aLayer) * 0.08;
    float gatedAmp = max(amp - gate, 0.0) / max(1.0 - gate, 0.01);

    // Radial direction from center
    vec3 dir = normalize(position);
    float r = length(position);

    // Radial pulse: shells expand outward with audio
    float radialPush = gatedAmp * uPulse * (0.3 + aLayer * 0.7);

    // Stellar current: particles stream along their shell surface
    vec3 tangent = normalize(cross(dir, vec3(0.0, 1.0, 0.001)));
    vec3 bitangent = normalize(cross(dir, tangent));
    float erode1 = sin(aSpread * 5.0 + uTime * 0.7 + aPhase) * uCurrent * gatedAmp * 0.15;
    float erode2 = cos(aPhase * 3.0 + uTime * 0.5) * uCurrent * gatedAmp * 0.1;

    // Time dilation: deforms the shell non-uniformly
    float warp1 = sin(aSpread * uDilation * 3.0 + uTime * 0.4) * 0.12;
    float warp2 = cos(aLayer * 8.0 + uTime * 0.3 + aPhase) * 0.08;
    float tecWarp = (warp1 + warp2) * (0.4 + gatedAmp * 1.5);

    vec3 newPos = position;
    // Shells expand outward
    newPos += dir * (radialPush * 0.6 + tecWarp);
    // Stellar current streams particles along shell
    newPos += tangent * erode1 + bitangent * erode2;

    // Slow time: shells breathe in and out
    float breath = sin(uTime * 0.15 + aLayer * 3.14) * 0.03;
    newPos += dir * breath;

    vLayer = aLayer;
    vFreqAmp = gatedAmp;
    vDepth = aSpread;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Point size: inner shells slightly smaller, outer slightly larger
    float baseSize = mix(0.6, 1.3, aLayer);
    gl_PointSize = (baseSize + gatedAmp * 2.5) * (260.0 / -mvPos.z) * step(0.005, gatedAmp) + 1.0;

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
  varying float vLayer;
  varying float vFreqAmp;
  varying float vDepth;
  uniform float uAge;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = 1.0 - smoothstep(0.2, 0.5, dist);

    // Palette: Age shifts between remnant-cool (0) and main-sequence blaze (1)
    // Inner shells: core plasma; outer shells: corona light
    vec3 coreOld    = vec3(0.15, 0.08, 0.05);
    vec3 coreNew    = vec3(0.40, 0.08, 0.03);
    vec3 plasmaOld  = vec3(0.25, 0.18, 0.12);
    vec3 plasmaNew  = vec3(0.60, 0.30, 0.08);
    vec3 coronaOld  = vec3(0.18, 0.25, 0.35);
    vec3 coronaNew  = vec3(0.35, 0.50, 0.30);
    vec3 nebulaOld  = vec3(0.30, 0.40, 0.55);
    vec3 nebulaNew  = vec3(0.70, 0.55, 0.25);

    vec3 core    = mix(coreOld, coreNew, uAge);
    vec3 plasma  = mix(plasmaOld, plasmaNew, uAge);
    vec3 corona  = mix(coronaOld, coronaNew, uAge);
    vec3 nebula  = mix(nebulaOld, nebulaNew, uAge);

    float l = vLayer;
    vec3 color;
    if (l < 0.25) {
      color = mix(core, plasma, l / 0.25);
    } else if (l < 0.5) {
      color = mix(plasma, corona, (l - 0.25) / 0.25);
    } else if (l < 0.75) {
      color = mix(corona, nebula, (l - 0.5) / 0.25);
    } else {
      color = mix(nebula, nebula * 1.3, (l - 0.75) / 0.25);
    }

    // Audio brightens — plasma filaments through ionized time
    color = mix(color, color * 2.0 + vec3(0.05, 0.03, 0.01), vFreqAmp * 0.4);

    // Shell-based alpha: mid-shells more opaque, edges ethereal
    float layerAlpha = mix(0.5, 0.8, 1.0 - abs(vLayer * 2.0 - 1.0));
    alpha *= layerAlpha * (0.4 + vFreqAmp * 0.6);

    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.3, 4.5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime: { value: 0.0 },
  uPulse: { value: 1.2 },
  uCurrent: { value: 0.5 },
  uDilation: { value: 2.0 },
  uStrata: { value: 0.7 },
  uAge: { value: 0.5 },
  uDecay: { value: 0.5 },
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
  const epoch   = sliders.p1.value / 100;  // Epoch — how far the pulse reaches
  const drift   = sliders.p2.value / 100;  // Drift — the slow wander of light
  const dilation = sliders.p3.value / 100; // Dilation — where gravity bends time
  const stratum = sliders.p4.value / 100;  // Stratum — depth of the burning

  // Dilation amplifies epoch (gravity deepens the pulse)
  const effectiveEpoch = epoch * (1.0 + dilation * 0.5);
  // Dilation dampens drift (curved spacetime slows the wander)
  const effectiveDrift = drift * (1.0 - dilation * 0.25);

  const pulse = 0.3 + effectiveEpoch * 2.5;
  const current = 0.1 + effectiveDrift * 1.2;
  const dilationVal = 0.5 + dilation * 4.5;
  const flux = 0.3 + drift * 3.0;

  const rotSpeedY = 0.03 + effectiveDrift * 0.35;
  const rotSpeedX = 0.02 + effectiveDrift * 0.15;
  const smoothing = 0.92 - dilation * 0.6;

  const detail = Math.floor(4 + stratum * 35);
  const strata = 0.4 + stratum * 0.6;

  return {
    pulse, current, dilation: dilationVal, strata, flux, rotSpeedY, rotSpeedX, smoothing, detail,
    age: sliders.p5.value / 100,
    memory: sliders.p6.value / 100,
    decay: sliders.p7.value / 100,
    entropy: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  const shells = Math.floor(5 + detail * 0.5);
  const positions = [];
  const layerAttrs = [];
  const spreadAttrs = [];
  const phaseAttrs = [];

  for (let s = 0; s < shells; s++) {
    const shellNorm = s / (shells - 1);
    // Each shell is a sphere at a certain radius — inner = core, outer = corona
    const radius = 0.2 + shellNorm * 1.6;
    // More particles on outer shells (larger surface area)
    const ptsOnShell = Math.floor((16 + detail * 0.9) * (0.4 + shellNorm * 0.6));
    // Distribute via fibonacci sphere for even coverage
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let p = 0; p < ptsOnShell; p++) {
      const spreadNorm = p / (ptsOnShell - 1);
      // Fibonacci sphere distribution
      const y = 1 - (2 * p) / (ptsOnShell - 1);
      const radXZ = Math.sqrt(1 - y * y);
      const theta = goldenAngle * p;
      const x = Math.cos(theta) * radXZ * radius;
      const z = Math.sin(theta) * radXZ * radius;
      const yPos = y * radius;
      // Slight natural jitter
      const jitter = 0.03 + shellNorm * 0.02;
      const jx = (Math.random() - 0.5) * jitter;
      const jy = (Math.random() - 0.5) * jitter;
      const jz = (Math.random() - 0.5) * jitter;
      positions.push(x + jx, yPos + jy, z + jz);
      layerAttrs.push(shellNorm);
      spreadAttrs.push(spreadNorm);
      phaseAttrs.push(Math.random() * Math.PI * 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aLayer', new THREE.Float32BufferAttribute(layerAttrs, 1));
  geometry.setAttribute('aSpread', new THREE.Float32BufferAttribute(spreadAttrs, 1));
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

let rotSpeedY = 0.08;
let rotSpeedX = 0.04;
let bakedMemory = 0.5;
let bakedEntropy = 0.5;
let seedCenter = {
  pulse: 1.2,
  current: 0.5,
  dilation: 2.0,
  strata: 0.7,
  flux: 1.5
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

  uniforms.uPulse.value = seeds.pulse;
  uniforms.uCurrent.value = seeds.current;
  uniforms.uDilation.value = seeds.dilation;
  uniforms.uStrata.value = seeds.strata;
  uniforms.uAge.value = seeds.age;
  uniforms.uDecay.value = seeds.decay;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    pulse: seeds.pulse,
    current: seeds.current,
    dilation: seeds.dilation,
    strata: seeds.strata,
    flux: seeds.flux
  };
  bakedMemory = seeds.memory;
  bakedEntropy = seeds.entropy;
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

// Act I:   Protostar     (0-15%)   — dense molecular cloud, barely luminous
// Act II:  Ignition      (15-40%)  — fusion begins, plasma stirs
// Act III: Main Sequence  (40-60%)  — full radiance, time burns fastest here
// Act IV:  Red Giant      (60-82%)  — time slowing, the envelope expands
// Act V:   Remnant        (82-100%) — white dwarf pulse, only memory of light
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));

  const sm = (edge0, edge1, x) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  const pulseArc = 0.2
    + 0.2 * sm(0.0, 0.15, p)
    + 0.8 * sm(0.15, 0.45, p)
    - 0.3 * sm(0.60, 0.82, p)
    - 0.5 * sm(0.82, 1.0, p);

  const currentArc = 0.3
    + 0.15 * sm(0.05, 0.2, p)
    + 0.6 * sm(0.2, 0.5, p)
    - 0.2 * sm(0.55, 0.75, p)
    - 0.5 * sm(0.8, 1.0, p);

  const dilationArc = 0.3
    + 0.1 * sm(0.1, 0.25, p)
    + 0.7 * sm(0.25, 0.50, p)
    - 0.15 * sm(0.55, 0.7, p)
    + 0.1 * sm(0.7, 0.8, p)
    - 0.6 * sm(0.82, 1.0, p);

  const strataArc = 0.5
    + 0.15 * sm(0.05, 0.2, p)
    + 0.35 * sm(0.2, 0.5, p)
    - 0.1 * sm(0.6, 0.75, p)
    - 0.35 * sm(0.8, 1.0, p);

  const fluxArc = 0.3
    + 0.2 * sm(0.1, 0.25, p)
    + 0.6 * sm(0.25, 0.50, p)
    - 0.2 * sm(0.55, 0.72, p)
    - 0.5 * sm(0.82, 1.0, p);

  const rotArc = 0.4
    + 0.15 * sm(0.1, 0.3, p)
    + 0.45 * sm(0.3, 0.55, p)
    - 0.25 * sm(0.7, 0.88, p)
    - 0.35 * sm(0.88, 1.0, p);

  return {
    pulse: Math.max(0.1, pulseArc),
    current: Math.max(0.05, currentArc),
    dilation: Math.max(0.2, dilationArc),
    strata: Math.max(0.2, strataArc),
    flux: Math.max(0.1, fluxArc),
    rot: Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();

const DRIFT_BASE = 108;
const driftCycles = {
  pulse:      { period: DRIFT_BASE * 1.000, depth: 0.30 },
  current:    { period: DRIFT_BASE * 0.786, depth: 0.35 },
  dilation:   { period: DRIFT_BASE * 1.272, depth: 0.30 },
  strata:     { period: DRIFT_BASE * 1.618, depth: 0.20 },
  flux:       { period: DRIFT_BASE * 0.618, depth: 0.35 },
};

const uniformMap = {
  pulse: 'uPulse',
  current: 'uCurrent',
  dilation: 'uDilation',
  strata: 'uStrata',
  flux: 'uDilation' // flux modulates dilation over time
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { pulse: 1, current: 1, dilation: 1, strata: 1, flux: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const songElapsed = audioContext.currentTime - audioStartTime;
    const progress = Math.min(songElapsed / audioDuration, 1.0);
    const rawArc = storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedMemory;
    }
  }

  const TWO_PI = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedEntropy * 1.4);
    const phase1 = Math.sin(dt * TWO_PI / period + (_dp[key] || 0));
    const phase2 = Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0));
    const drift = (phase1 * 0.65 + phase2 * 0.35) * scaledDepth;

    // Apply to the correct uniform
    const uName = key === 'flux' ? 'uDilation' : ('u' + key.charAt(0).toUpperCase() + key.slice(1));
    if (key !== 'flux') {
      uniforms[uName].value = Math.max(0.01, seedCenter[key] * arcMult[key] * (1.0 + drift));
    }
  }

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.12;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.08;

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
  uniforms.uPulse.value = seeds.pulse;
  uniforms.uCurrent.value = seeds.current;
  uniforms.uDilation.value = seeds.dilation;
  uniforms.uStrata.value = seeds.strata;
  uniforms.uAge.value = seeds.age;
  uniforms.uDecay.value = seeds.decay;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { pulse: seeds.pulse, current: seeds.current, dilation: seeds.dilation, strata: seeds.strata, flux: seeds.flux };
  bakedMemory = seeds.memory;
  bakedEntropy = seeds.entropy;
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
  get bakedArcScale() { return bakedMemory; },
  get bakedDriftScale() { return bakedEntropy; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap,
  rotXMult: 0.3, rotDriftScale: 0.12, tiltDriftScale: 0.08,
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
  sceneName: 'ember'
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
