const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uBloomAmp;
  uniform float uWaveMag;
  uniform float uWaveFreq;
  uniform float uWaveSpeed;
  uniform float uFreqSpread;
  uniform float uDew;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aRadius;
  attribute float aAngle;
  attribute float aSide;
  varying float vDisplacement;
  varying float vRadius;
  varying float vFreqAmp;

  void main() {
    float normR = aRadius * uFreqSpread;
    int idx = int(clamp(floor(normR * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Core intensity: center particles erupt harder, fades with radius
    float coreFactor = 1.0 - smoothstep(0.0, 0.6, aRadius);
    float discFactor = smoothstep(0.1, 0.5, aRadius);

    // Gate: treat low levels as silence — Dew controls core sensitivity
    float gate = uDew * 0.3 + coreFactor * (0.1 + uDew * 0.2);
    float gatedAmp = max(amp - gate, 0.0) / max(1.0 - gate, 0.01);
    float displacement = gatedAmp * uBloomAmp;

    // Bilateral jet: center blasts up/down based on aSide
    float jetDisp = displacement * coreFactor * 1.0 * aSide;
    // Disc ripple: outer particles stay flatter
    float discDisp = displacement * discFactor * 0.4;

    // Layered wave motion across the field
    float wave1 = sin(aRadius * uWaveFreq * 6.2832 + uTime * uWaveSpeed);
    float wave2 = cos(aAngle * 3.0 + uTime * uWaveSpeed * 0.6);
    float wave3 = sin((aRadius + aAngle * 0.5) * uWaveFreq * 3.0 - uTime * uWaveSpeed * 0.8);
    float waveDisp = (wave1 * 0.5 + wave2 * 0.3 + wave3 * 0.2) * uWaveMag;

    vec3 newPos = position;
    newPos.y += jetDisp + discDisp + waveDisp * (0.3 + discFactor * 0.7);

    // Slight radial push from center on bass hits
    float radialPush = displacement * coreFactor * 0.1;
    newPos.x += newPos.x * radialPush;
    newPos.z += newPos.z * radialPush;

    vDisplacement = clamp(abs(jetDisp) + discDisp + waveDisp * 0.5, 0.0, 1.0);
    vRadius = aRadius;
    vFreqAmp = gatedAmp;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Point size: tiny at core to prevent overlap saturation, bigger at edges
    float baseSize = mix(0.4, 1.2, vRadius);
    gl_PointSize = (baseSize + abs(jetDisp + discDisp) * 3.0) * (300.0 / -mvPos.z) * step(0.01, displacement) + 1.0;

    // Viewport constraint: account for point radius in pixels when clamping
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
  varying float vDisplacement;
  varying float vRadius;
  varying float vFreqAmp;
  uniform float uDusk;

  void main() {
    // Circular point sprite
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = 1.0 - smoothstep(0.3, 0.5, dist);

    // Spectral palette: Dusk shifts temperature (0=cool, 1=warm)
    vec3 c0 = mix(vec3(0.12, 0.05, 0.30), vec3(0.20, 0.05, 0.12), uDusk);
    vec3 c1 = mix(vec3(0.25, 0.10, 0.60), vec3(0.45, 0.10, 0.30), uDusk);
    vec3 c2 = mix(vec3(0.10, 0.35, 0.85), vec3(0.60, 0.25, 0.50), uDusk);
    vec3 c3 = mix(vec3(0.0,  0.75, 0.75), vec3(0.90, 0.50, 0.20), uDusk);
    vec3 c4 = mix(vec3(0.15, 0.85, 0.40), vec3(0.95, 0.65, 0.15), uDusk);
    vec3 c5 = mix(vec3(0.95, 0.75, 0.20), vec3(1.0, 0.35, 0.10), uDusk);

    float a = vFreqAmp;
    vec3 color;
    if (a < 0.2) {
      color = mix(c0, c1, a / 0.2);
    } else if (a < 0.4) {
      color = mix(c1, c2, (a - 0.2) / 0.2);
    } else if (a < 0.6) {
      color = mix(c2, c3, (a - 0.4) / 0.2);
    } else if (a < 0.8) {
      color = mix(c3, c4, (a - 0.6) / 0.2);
    } else {
      color = mix(c4, c5, (a - 0.8) / 0.2);
    }

    // Subtle radial tint: inner particles slightly warmer
    color = mix(color, color * vec3(1.1, 0.9, 0.85), (1.0 - vRadius) * 0.2);

    // Core particles: lower alpha to prevent additive white-out
    float coreAlphaScale = mix(0.15, 1.0, smoothstep(0.0, 0.4, vRadius));
    alpha *= (0.5 + vFreqAmp * 0.5) * coreAlphaScale;

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
  uBloomAmp: { value: 1.5 },
  uWaveMag: { value: 0.15 },
  uWaveFreq: { value: 3.0 },
  uWaveSpeed: { value: 2.0 },
  uFreqSpread: { value: 0.7 },
  uDusk: { value: 0.5 },
  uDew: { value: 0.5 },
  uViewport: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uBoundary:  { value: 1.0 }
};

const sliders = {
  bloom: document.getElementById('bloom'),
  drift: document.getElementById('drift'),
  current: document.getElementById('current'),
  rhizome: document.getElementById('rhizome'),
  dusk: document.getElementById('dusk'),
  mycelium: document.getElementById('mycelium'),
  dew: document.getElementById('dew'),
  flutter: document.getElementById('flutter')
};
const valDisplays = {
  bloom: document.getElementById('bloom-val'),
  drift: document.getElementById('drift-val'),
  current: document.getElementById('current-val'),
  rhizome: document.getElementById('rhizome-val'),
  dusk: document.getElementById('dusk-val'),
  mycelium: document.getElementById('mycelium-val'),
  dew: document.getElementById('dew-val'),
  flutter: document.getElementById('flutter-val')
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
  const bloom = sliders.bloom.value / 100;
  const drift = sliders.drift.value / 100;
  const current = sliders.current.value / 100;
  const rhizome = (sliders.rhizome.value / 100 - 0.5) * 0.5;

  // Current dampens bloom (turbulent water scatters growth)
  const effectiveBloom = bloom * (1.0 - current * 0.3);
  // Current amplifies drift (the river carries petals further)
  const effectiveDrift = drift * (1.0 + current * 0.6);
  // Rhizome complexity deepens bloom sensitivity (more roots = more nutrients)
  const bloomAmp = (0.3 + effectiveBloom * 2.7) * (1.0 + rhizome * 0.4);
  const waveMag = 0.03 + effectiveBloom * 0.3;

  const rotSpeedY = 0.05 + effectiveDrift * 0.45;
  const rotSpeedX = 0.03 + effectiveDrift * 0.3;
  const waveFreq = 1.0 + effectiveDrift * 5.0;

  const waveSpeed = 0.5 + current * 4.0;
  const smoothing = 0.92 - current * 0.7;

  const detail = Math.floor(3 + rhizome * 40);
  const freqSpread = 0.5 + rhizome * 0.5;

  return { bloomAmp, waveMag, waveFreq, waveSpeed, freqSpread, rotSpeedY, rotSpeedX, smoothing, detail,
    dusk: sliders.dusk.value / 100,
    mycelium: sliders.mycelium.value / 100,
    dew: sliders.dew.value / 100,
    flutter: sliders.flutter.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  // Rings of particles radiating outward — density from Rhizome (detail)
  const rings = Math.floor(8 + detail * 0.8);
  const positions = [];
  const radii = [];
  const angles = [];
  const sides = [];

  for (let r = 0; r < rings; r++) {
    const radius = (r / rings);
    // Fewer particles near center to prevent overlap, more at edges
    const densityScale = 0.3 + radius * 0.7;
    const circumPts = Math.max(4, Math.floor((6 + r * (2 + detail * 0.12)) * densityScale));
    // Near center: duplicate particles for both hemispheres
    const hemis = radius < 0.35 ? [1, -1] : [1];
    for (const side of hemis) {
      for (let a = 0; a < circumPts; a++) {
        const angle = (a / circumPts) * Math.PI * 2;
        const spread = 2.2;
        const x = Math.cos(angle) * radius * spread;
        const z = Math.sin(angle) * radius * spread;
        positions.push(x, 0, z);
        radii.push(radius);
        angles.push(angle);
        sides.push(side);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aRadius', new THREE.Float32BufferAttribute(radii, 1));
  geometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angles, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));

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
buildParticles(20); // default until audio loads

let rotSpeedY = 0.15;
let rotSpeedX = 0.1;
let bakedMycelium = 0.6;
let bakedFlutter = 0.45;
let seedCenter = {
  bloomAmp: 1.5,
  waveMag: 0.15,
  waveFreq: 3.0,
  waveSpeed: 2.0,
  freqSpread: 0.7
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
  analyser.fftSize = 128; // 64 frequency bins
  analyser.smoothingTimeConstant = 0; _sceneSm = smoothing;
  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

let currentBuffer = null, currentFileName = '';
let playState = 'idle'; // idle | playing | paused
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

  uniforms.uBloomAmp.value = seeds.bloomAmp;
  uniforms.uWaveMag.value = seeds.waveMag;
  uniforms.uWaveFreq.value = seeds.waveFreq;
  uniforms.uWaveSpeed.value = seeds.waveSpeed;
  uniforms.uFreqSpread.value = seeds.freqSpread;
  uniforms.uDusk.value = seeds.dusk;
  uniforms.uDew.value = seeds.dew;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    bloomAmp: seeds.bloomAmp,
    waveMag: seeds.waveMag,
    waveFreq: seeds.waveFreq,
    waveSpeed: seeds.waveSpeed,
    freqSpread: seeds.freqSpread
  };
  bakedMycelium = seeds.mycelium;
  bakedFlutter = seeds.flutter;
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

// Act I:   Emergence (0-15%)   — hushed, intimate, waking up
// Act II:  Rising    (15-40%)  — opening outward, building energy
// Act III: Climax    (40-65%)  — full bloom, maximum expression
// Act IV:  Falling   (65-85%)  — reflective, softening with memory
// Act V:   Return    (85-100%) — dissolving back to stillness
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));

  const sm = (edge0, edge1, x) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  const bloomArc = 0.3
    + 0.3 * sm(0.0, 0.15, p)
    + 0.5 * sm(0.15, 0.45, p)
    - 0.2 * sm(0.65, 0.85, p)
    - 0.5 * sm(0.85, 1.0, p);

  const waveMagArc = 0.2
    + 0.2 * sm(0.05, 0.2, p)
    + 0.7 * sm(0.25, 0.55, p)
    - 0.3 * sm(0.6, 0.8, p)
    - 0.5 * sm(0.85, 1.0, p);

  const waveFreqArc = 0.6
    + 0.15 * sm(0.1, 0.3, p)
    + 0.4 * sm(0.3, 0.5, p)
    - 0.25 * sm(0.65, 0.85, p)
    - 0.3 * sm(0.88, 1.0, p);

  const waveSpeedArc = 0.4
    + 0.25 * sm(0.1, 0.25, p)
    + 0.5 * sm(0.25, 0.5, p)
    - 0.15 * sm(0.55, 0.7, p)
    + 0.15 * sm(0.7, 0.8, p)
    - 0.6 * sm(0.82, 1.0, p);

  const freqSpreadArc = 0.5
    + 0.15 * sm(0.05, 0.2, p)
    + 0.4 * sm(0.2, 0.5, p)
    - 0.1 * sm(0.6, 0.75, p)
    - 0.4 * sm(0.8, 1.0, p);

  const rotArc = 0.5
    + 0.2 * sm(0.1, 0.3, p)
    + 0.5 * sm(0.3, 0.55, p)
    - 0.3 * sm(0.7, 0.9, p)
    - 0.4 * sm(0.9, 1.0, p);

  return {
    bloomAmp: Math.max(0.1, bloomArc),
    waveMag: Math.max(0.05, waveMagArc),
    waveFreq: Math.max(0.3, waveFreqArc),
    waveSpeed: Math.max(0.15, waveSpeedArc),
    freqSpread: Math.max(0.2, freqSpreadArc),
    rot: Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();

// ~4 minute base cycle (240s), with irrational ratios so they never align
const DRIFT_BASE = 108;
const driftCycles = {
  bloomAmp:  { period: DRIFT_BASE * 1.000, depth: 0.35 },  // 4:00
  waveMag:   { period: DRIFT_BASE * 0.786, depth: 0.40 },  // ~3:09 (golden-ish)
  waveFreq:  { period: DRIFT_BASE * 1.272, depth: 0.30 },  // ~5:05
  waveSpeed: { period: DRIFT_BASE * 0.618, depth: 0.35 },  // ~2:28 (golden ratio)
  freqSpread:{ period: DRIFT_BASE * 1.618, depth: 0.25 },  // ~6:28 (phi)
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { bloomAmp: 1, waveMag: 1, waveFreq: 1, waveSpeed: 1, freqSpread: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const songElapsed = audioContext.currentTime - audioStartTime;
    const progress = Math.min(songElapsed / audioDuration, 1.0);
    const rawArc = storyArc(progress);
    // Mycelium: 0 = ignore the arc (freeform), 1 = fully follow the narrative
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedMycelium;
    }
  }

  const TWO_PI = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    // Flutter scales how far the drift wanders
    const scaledDepth = depth * (0.3 + bakedFlutter * 1.4);
    // Primary wave + a slower sub-harmonic for asymmetry
    const phase1 = Math.sin(dt * TWO_PI / period + (_dp[key] || 0));
    const phase2 = Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0));
    const drift = (phase1 * 0.65 + phase2 * 0.35) * scaledDepth;
    // Modulate: seed center × narrative arc × drift breathing
    uniforms['u' + key.charAt(0).toUpperCase() + key.slice(1)].value =
      Math.max(0.01, seedCenter[key] * arcMult[key] * (1.0 + drift));
  }

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.15;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.12;

  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < 64; i++) {
      const a = i < 2 ? _bassSm : _sceneSm;
      _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i];
      frequencyUniform[i] = _smoothedFreq[i];
    }
  }

  particles.rotation.y = elapsed * rotSpeedY * arcMult.rot * (1.0 + rotDrift);
  particles.rotation.x = elapsed * rotSpeedX * 0.4 * arcMult.rot * (1.0 + tiltDrift);

  renderer.render(scene, camera);
}

function _vjApply() {
  const seeds = computeSeedValues();
  uniforms.uBloomAmp.value = seeds.bloomAmp;
  uniforms.uWaveMag.value = seeds.waveMag;
  uniforms.uWaveFreq.value = seeds.waveFreq;
  uniforms.uWaveSpeed.value = seeds.waveSpeed;
  uniforms.uFreqSpread.value = seeds.freqSpread;
  uniforms.uDusk.value = seeds.dusk;
  uniforms.uDew.value = seeds.dew;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { bloomAmp: seeds.bloomAmp, waveMag: seeds.waveMag, waveFreq: seeds.waveFreq, waveSpeed: seeds.waveSpeed, freqSpread: seeds.freqSpread };
  bakedMycelium = seeds.mycelium;
  bakedFlutter = seeds.flutter;
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
  get bakedArcScale() { return bakedMycelium; },
  get bakedDriftScale() { return bakedFlutter; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap: { bloomAmp:'uBloomAmp', waveMag:'uWaveMag', waveFreq:'uWaveFreq', waveSpeed:'uWaveSpeed', freqSpread:'uFreqSpread' },
  rotXMult: 0.4, rotDriftScale: 0.15, tiltDriftScale: 0.12,
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
  sceneName: 'smbh'
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
