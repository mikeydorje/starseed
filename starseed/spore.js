const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uScatter;
  uniform float uGerminate;
  uniform float uCanopy;
  uniform float uRoot;
  uniform float uDormant;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aCluster;
  attribute float aLocal;
  attribute float aPhase;
  attribute vec3 aNodeCenter;
  varying float vCluster;
  varying float vFreqAmp;
  varying float vLocal;
  const float VIS_INPUT_GAIN = 1.25892541; // +2 dB visual boost

  void main() {
    // Each cluster reads from a frequency bin
    float normCluster = aCluster * uRoot;
    int idx = int(clamp(floor(normCluster * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Gate quiet signals
    float gate = uDormant * 0.3;
    float gatedAmp = (max(amp - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Direction from cluster center
    vec3 toCenter = position - aNodeCenter;
    vec3 dir = length(toCenter) > 0.001 ? normalize(toCenter) : vec3(0.0, 1.0, 0.0);

    // Scatter: particles push outward from their cluster node with audio
    float scatter = gatedAmp * uScatter * 0.5;

    // Germinate: vertical drift bias — seeds float upward on energy
    float rise = gatedAmp * uGerminate * 0.3 * (0.5 + aLocal);

    // Canopy: horizontal spread modulated by time
    float sway = sin(uTime * 0.8 + aPhase * 2.0 + aCluster * 5.0) * uCanopy * 0.15;
    float sway2 = cos(uTime * 0.5 + aLocal * 4.0) * uCanopy * 0.08;

    vec3 newPos = position;
    // Disperse outward from cluster
    newPos += dir * scatter;
    // Float upward
    newPos.y += rise;
    // Lateral sway
    newPos.x += sway * (0.3 + gatedAmp * 0.7);
    newPos.z += sway2 * (0.3 + gatedAmp * 0.7);
    // Gentle breathing oscillation per cluster
    float pulse = sin(uTime * 0.3 + aCluster * 3.14) * 0.02;
    newPos += dir * pulse;

    vCluster = aCluster;
    vFreqAmp = gatedAmp;
    vLocal = aLocal;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Sharp small points
    float baseSize = 0.8;
    gl_PointSize = (baseSize + gatedAmp * 1.5) * (180.0 / -mvPos.z) * step(0.005, gatedAmp) + 0.7;

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
  varying float vCluster;
  varying float vFreqAmp;
  varying float vLocal;
  uniform float uChlorophyll;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Sharp core — tight edge, minimal softness
    float alpha = 1.0 - smoothstep(0.12, 0.42, dist);
    // Very faint halo accent
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.06;

    // Palette: Chlorophyll shifts cool/botanical (0) to warm/golden (1)
    vec3 coolSeed  = vec3(0.30, 0.65, 0.40);
    vec3 coolStem  = vec3(0.20, 0.50, 0.35);
    vec3 warmSeed  = vec3(0.80, 0.70, 0.25);
    vec3 warmStem  = vec3(0.65, 0.50, 0.20);
    vec3 coolLight = vec3(0.75, 0.90, 0.80);
    vec3 warmLight = vec3(0.95, 0.90, 0.70);

    vec3 seed = mix(coolSeed, warmSeed, uChlorophyll);
    vec3 stem = mix(coolStem, warmStem, uChlorophyll);
    vec3 light = mix(coolLight, warmLight, uChlorophyll);

    // Color varies by cluster and local position
    vec3 color = mix(stem, seed, vLocal);
    // Audio brightens toward white/pale
    color = mix(color, light, vFreqAmp * 0.55);
    // Cluster variation adds subtle hue shift
    color += vec3(sin(vCluster * 6.28) * 0.05, cos(vCluster * 4.0) * 0.03, 0.0);

    // Sharp alpha — high base
    alpha *= 0.75 + vFreqAmp * 0.25;
    alpha += halo;

    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.5, 5.5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime: { value: 0.0 },
  uScatter: { value: 1.2 },
  uGerminate: { value: 1.0 },
  uCanopy: { value: 0.7 },
  uRoot: { value: 0.7 },
  uChlorophyll: { value: 0.5 },
  uDormant: { value: 0.5 },
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
  const scatter   = sliders.p1.value / 100;
  const germinate = sliders.p2.value / 100;
  const canopy    = sliders.p3.value / 100;
  const root      = sliders.p4.value / 100;

  // Germinate amplifies scatter (energy disperses seeds)
  const effectiveScatter = scatter * (1.0 + germinate * 0.4);
  // Root dampens canopy (strong roots resist sway)
  const effectiveCanopy = canopy * (1.0 - root * 0.25);

  return {
    scatter: 0.3 + effectiveScatter * 2.5,
    germinate: 0.2 + germinate * 2.0,
    canopy: 0.2 + effectiveCanopy * 1.8,
    root: 0.3 + root * 0.7,
    rotSpeedY: 0.015 + canopy * 0.12,
    rotSpeedX: 0.008 + canopy * 0.06,
    smoothing: 0.88 - germinate * 0.5,
    detail: Math.floor(6 + root * 30),
    chlorophyll: sliders.p5.value / 100,
    chronicle: sliders.p6.value / 100,
    dormant: sliders.p7.value / 100,
    meander: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  const clusters = Math.floor(6 + detail * 0.4);
  const positions = [];
  const clusterAttrs = [];
  const localAttrs = [];
  const phaseAttrs = [];
  const nodeCenters = [];

  // Generate cluster centers spread across space — no center bias
  const centers = [];
  const goldenAngle = 2.39996;
  for (let c = 0; c < clusters; c++) {
    const t = c / clusters;
    // Spread in a volume, offset from origin
    const theta = goldenAngle * c;
    const phi = Math.acos(1 - 2 * (c + 0.5) / clusters);
    const r = 1.2 + Math.sin(c * 1.618) * 0.8;
    centers.push(new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * r,
      Math.sin(phi) * Math.sin(theta) * r * 0.7 + (Math.random() - 0.5) * 0.5,
      Math.cos(phi) * r
    ));
  }

  for (let c = 0; c < clusters; c++) {
    const clusterNorm = c / (clusters - 1);
    const center = centers[c];
    const ptsInCluster = Math.floor(12 + detail * 0.8);

    for (let p = 0; p < ptsInCluster; p++) {
      const localNorm = p / (ptsInCluster - 1);
      // Points scattered around cluster center — small sphere cloud
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = Math.random() * 0.35;
      const x = center.x + Math.sin(phi) * Math.cos(theta) * r;
      const y = center.y + Math.sin(phi) * Math.sin(theta) * r;
      const z = center.z + Math.cos(phi) * r;

      positions.push(x, y, z);
      clusterAttrs.push(clusterNorm);
      localAttrs.push(localNorm);
      phaseAttrs.push(Math.random() * Math.PI * 2);
      nodeCenters.push(center.x, center.y, center.z);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aCluster', new THREE.Float32BufferAttribute(clusterAttrs, 1));
  geometry.setAttribute('aLocal', new THREE.Float32BufferAttribute(localAttrs, 1));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phaseAttrs, 1));
  geometry.setAttribute('aNodeCenter', new THREE.Float32BufferAttribute(nodeCenters, 3));

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

let rotSpeedY = 0.03;
let rotSpeedX = 0.015;
let bakedChronicle = 0.5;
let bakedMeander = 0.5;
let seedCenter = {
  scatter: 1.2,
  germinate: 1.0,
  canopy: 0.7,
  root: 0.7
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

  uniforms.uScatter.value = seeds.scatter;
  uniforms.uGerminate.value = seeds.germinate;
  uniforms.uCanopy.value = seeds.canopy;
  uniforms.uRoot.value = seeds.root;
  uniforms.uChlorophyll.value = seeds.chlorophyll;
  uniforms.uDormant.value = seeds.dormant;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    scatter: seeds.scatter,
    germinate: seeds.germinate,
    canopy: seeds.canopy,
    root: seeds.root
  };
  bakedChronicle = seeds.chronicle;
  bakedMeander = seeds.meander;
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

// Act I:   Dormant (0-12%)    — seeds barely visible, waiting
// Act II:  Germinate (12-32%) — clusters stir, particles begin to separate
// Act III: Disperse (32-58%)  — full scatter, seeds sailing through space
// Act IV:  Float (58-80%)     — gentle plateau, drifting currents
// Act V:   Settle (80-100%)   — seeds slow, regroup, return to stillness
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const sm = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const scatterArc = 0.15
    + 0.15 * sm(0.0, 0.12, p)
    + 0.6  * sm(0.12, 0.4, p)
    + 0.2  * sm(0.4, 0.58, p)
    - 0.2  * sm(0.65, 0.82, p)
    - 0.5  * sm(0.82, 1.0, p);

  const germinateArc = 0.2
    + 0.3  * sm(0.05, 0.2, p)
    + 0.5  * sm(0.2, 0.45, p)
    - 0.15 * sm(0.55, 0.72, p)
    - 0.5  * sm(0.8, 1.0, p);

  const canopyArc = 0.3
    + 0.1  * sm(0.1, 0.25, p)
    + 0.6  * sm(0.25, 0.5, p)
    - 0.2  * sm(0.6, 0.78, p)
    - 0.4  * sm(0.82, 1.0, p);

  const rootArc = 0.5
    + 0.15 * sm(0.05, 0.2, p)
    + 0.35 * sm(0.2, 0.5, p)
    - 0.1  * sm(0.6, 0.75, p)
    - 0.35 * sm(0.8, 1.0, p);

  const rotArc = 0.3
    + 0.2  * sm(0.1, 0.3, p)
    + 0.5  * sm(0.3, 0.58, p)
    - 0.2  * sm(0.65, 0.82, p)
    - 0.4  * sm(0.85, 1.0, p);

  return {
    scatter:   Math.max(0.1, scatterArc),
    germinate: Math.max(0.1, germinateArc),
    canopy:    Math.max(0.1, canopyArc),
    root:      Math.max(0.2, rootArc),
    rot:       Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();

const DRIFT_BASE = 108;
const driftCycles = {
  scatter:   { period: DRIFT_BASE * 1.000, depth: 0.30 },
  germinate: { period: DRIFT_BASE * 0.786, depth: 0.35 },
  canopy:    { period: DRIFT_BASE * 1.272, depth: 0.25 },
  root:      { period: DRIFT_BASE * 0.618, depth: 0.20 },
};

const uniformMap = {
  scatter:   'uScatter',
  germinate: 'uGerminate',
  canopy:    'uCanopy',
  root:      'uRoot'
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { scatter: 1, germinate: 1, canopy: 1, root: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const songElapsed = audioContext.currentTime - audioStartTime;
    const progress = Math.min(songElapsed / audioDuration, 1.0);
    const rawArc = storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedChronicle;
    }
  }

  const TWO_PI = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedMeander * 1.4);
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

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.06;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.03;

  particles.rotation.y = elapsed * rotSpeedY * (arcMult.rot || 1) * (1.0 + rotDrift);
  particles.rotation.x = elapsed * rotSpeedX * (arcMult.rot || 1) * (1.0 + tiltDrift);

  renderer.render(scene, camera);
}

function _vjApply() {
  const seeds = computeSeedValues();
  uniforms.uScatter.value = seeds.scatter;
  uniforms.uGerminate.value = seeds.germinate;
  uniforms.uCanopy.value = seeds.canopy;
  uniforms.uRoot.value = seeds.root;
  uniforms.uChlorophyll.value = seeds.chlorophyll;
  uniforms.uDormant.value = seeds.dormant;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { scatter: seeds.scatter, germinate: seeds.germinate, canopy: seeds.canopy, root: seeds.root };
  bakedChronicle = seeds.chronicle;
  bakedMeander = seeds.meander;
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
  get bakedArcScale() { return bakedChronicle; },
  get bakedDriftScale() { return bakedMeander; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap,
  rotXMult: 1.0, rotDriftScale: 0.06, tiltDriftScale: 0.03,
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
  sceneName: 'spore'
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
