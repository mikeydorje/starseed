const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uUnfurl;
  uniform float uPondRipple;
  uniform float uBreath;
  uniform float uStamen;
  uniform float uDewPoint;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aPetalLayer;
  attribute float aPetalAngle;
  attribute float aPetalPos;
  varying float vLayer;
  varying float vFreqAmp;
  varying float vCurl;
  const float VIS_INPUT_GAIN = 0.50118723; // -6 dB visual attenuation

  void main() {
    // Each petal reads from a frequency bin based on its layer (inner=bass, outer=treble)
    float normLayer = aPetalLayer * uStamen;
    int idx = int(clamp(floor(normLayer * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Gate quiet signals
    float gate = uDewPoint * 0.2 + (1.0 - aPetalLayer) * 0.1;
    float gatedAmp = (max(amp - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Petal curl: outer petals open more with audio, shaped by Unfurl
    float openAmount = gatedAmp * uUnfurl * aPetalLayer;
    float curl = openAmount * 0.8;

    // Vertical rise: inner petals lift higher (flower center), breath modulates
    float rise = gatedAmp * (1.0 - aPetalLayer * 0.6) * uBreath;

    // Pond surface ripple underneath
    float ripple = sin(aPetalAngle * 4.0 + uTime * 1.2) * uPondRipple * 0.08
                 + cos(aPetalLayer * 8.0 + uTime * 0.8) * uPondRipple * 0.05;

    vec3 newPos = position;
    // Petals tilt outward as they open (curl along Y relative to radius)
    newPos.y += rise * 0.6 + ripple;
    newPos.x += newPos.x * curl * 0.3;
    newPos.z += newPos.z * curl * 0.3;
    // Gentle swaying
    newPos.x += sin(uTime * 0.5 + aPetalAngle) * 0.02 * (1.0 + gatedAmp);

    vLayer = aPetalLayer;
    vFreqAmp = gatedAmp;
    vCurl = curl;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Point size: delicate at rest, swells with audio, outer petals larger
    float baseSize = mix(0.6, 1.4, aPetalLayer);
    gl_PointSize = (baseSize + gatedAmp * 3.5) * (280.0 / -mvPos.z) * step(0.005, gatedAmp) + 1.0;

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
  varying float vLayer;
  varying float vFreqAmp;
  varying float vCurl;
  uniform float uNectar;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Softer falloff than SMBH — organic, diffused edges
    float alpha = 1.0 - smoothstep(0.15, 0.5, dist);

    // Palette: Nectar shifts between cool moonlit (0) and warm sunrise (1)
    // Inner petals: cream/white/pink, outer: deeper rose/magenta/violet
    vec3 innerCool = vec3(0.85, 0.82, 0.90);
    vec3 innerWarm = vec3(0.95, 0.85, 0.75);
    vec3 midCool   = vec3(0.80, 0.45, 0.60);
    vec3 midWarm   = vec3(0.90, 0.50, 0.40);
    vec3 outerCool = vec3(0.45, 0.20, 0.50);
    vec3 outerWarm = vec3(0.70, 0.25, 0.30);
    vec3 deepCool  = vec3(0.15, 0.08, 0.25);
    vec3 deepWarm  = vec3(0.30, 0.08, 0.10);

    vec3 inner = mix(innerCool, innerWarm, uNectar);
    vec3 mid   = mix(midCool, midWarm, uNectar);
    vec3 outer = mix(outerCool, outerWarm, uNectar);
    vec3 deep  = mix(deepCool, deepWarm, uNectar);

    // Map layer + frequency to color
    float layerMix = vLayer;
    vec3 color;
    if (layerMix < 0.33) {
      color = mix(inner, mid, layerMix / 0.33);
    } else if (layerMix < 0.66) {
      color = mix(mid, outer, (layerMix - 0.33) / 0.33);
    } else {
      color = mix(outer, deep, (layerMix - 0.66) / 0.34);
    }

    // Audio brightens toward white/cream at the peaks
    color = mix(color, inner, vFreqAmp * 0.35);

    // Gentle transparency: inner more opaque, outer more ethereal
    alpha *= mix(0.7, 0.35, vLayer);
    alpha *= 0.5 + vFreqAmp * 0.5;

    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.8, 4);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime: { value: 0.0 },
  uUnfurl: { value: 1.2 },
  uPondRipple: { value: 0.5 },
  uBreath: { value: 1.0 },
  uStamen: { value: 0.7 },
  uNectar: { value: 0.5 },
  uDewPoint: { value: 0.5 },
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
  const unfurl   = sliders.p1.value / 100;
  const pond     = sliders.p2.value / 100;
  const breath   = sliders.p3.value / 100;
  const stamen   = sliders.p4.value / 100;
  const nectar   = sliders.p5.value / 100;
  const rootMem  = sliders.p6.value / 100;
  const dewPoint = sliders.p7.value / 100;
  const pollen   = sliders.p8.value / 100;

  // Breath deepens unfurl (breathing opens the petals wider)
  const effectiveUnfurl = unfurl * (1.0 + breath * 0.4);
  // Pond dampens breath (still water calms the breathing)
  const effectiveBreath = breath * (1.0 - pond * 0.25);
  // Stamen complexity scales with unfurl (more open = more inner detail visible)
  const effectiveStamen = stamen * (0.6 + effectiveUnfurl * 0.4);

  const uUnfurl = 0.3 + effectiveUnfurl * 2.0;
  const uPondRipple = 0.1 + pond * 1.5;
  const uBreath = 0.2 + effectiveBreath * 2.5;
  const uStamen = 0.3 + effectiveStamen * 0.7;

  const layers = Math.floor(5 + stamen * 25);
  const petalsPerRing = Math.floor(8 + unfurl * 20);

  const smoothing = 0.7 + pond * 0.25;

  const rotSpeedY = 0.02 + unfurl * 0.06 + pollen * 0.08;
  const rotSpeedX = 0.005 + pollen * 0.02;

  return {
    uUnfurl, uPondRipple, uBreath, uStamen,
    nectar, rootMem, dewPoint, pollen,
    layers, petalsPerRing, smoothing, rotSpeedY, rotSpeedX
  };
}

let particles;
function buildPetals(layers, petalsPerRing) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  const positions = [];
  const petalLayers = [];
  const petalAngles = [];
  const petalPositions = [];

  for (let l = 0; l < layers; l++) {
    const layerNorm = l / layers;
    const radius = 0.15 + layerNorm * 1.8;
    // Slight vertical offset: inner layers sit higher (flower cup), flipped to face camera
    const baseY = (1.0 - layerNorm) * 0.3 - layerNorm * 0.1;
    const ptsInRing = Math.floor(petalsPerRing * (0.4 + layerNorm * 0.6));
    // Each layer is rotated slightly (fibonacci-ish spiral)
    const layerRotation = l * 0.618 * Math.PI * 2;

    for (let p = 0; p < ptsInRing; p++) {
      const angle = (p / ptsInRing) * Math.PI * 2 + layerRotation;
      // Multiple points along each petal's radial extent
      const steps = 3;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const r = radius + t * (1.8 / layers) * 0.8;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        // Petals droop outward (flipped)
        const y = baseY + t * layerNorm * 0.15;
        positions.push(x, y, z);
        petalLayers.push(layerNorm);
        petalAngles.push(angle);
        petalPositions.push(t);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aPetalLayer', new THREE.Float32BufferAttribute(petalLayers, 1));
  geometry.setAttribute('aPetalAngle', new THREE.Float32BufferAttribute(petalAngles, 1));
  geometry.setAttribute('aPetalPos', new THREE.Float32BufferAttribute(petalPositions, 1));

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
buildPetals(15, 16);

let rotSpeedY = 0.04;
let rotSpeedX = 0.01;
let bakedRootMem = 0.55;
let bakedPollen = 0.4;
let seedCenter = {
  uUnfurl: 1.2,
  uPondRipple: 0.5,
  uBreath: 1.0,
  uStamen: 0.7
};

let audioContext = null;
let analyser = null;
let dataArray = null;
const _smoothedFreq = new Float32Array(64);
let _sceneSm = 0.85;
const _bassSm = 0.20;
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
  document.getElementById('upload-area').style.display = 'none'; document.getElementById('audio-loader').style.display = 'none';
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
  if (!data) { document.getElementById('audio-loader').style.display='none';document.getElementById('upload-area').style.display=''; return; }
  currentFileName = data.name;
  if (!audioContext) initAudio(0.85);
  audioContext.decodeAudioData(data.buffer, (buffer) => {
    currentBuffer = buffer;
    audioDuration = buffer.duration;
    showAudioReady();
  });
}).catch(() => { document.getElementById('audio-loader').style.display='none';document.getElementById('upload-area').style.display=''; });

function ensureAudio() {
  if (!audioContext) initAudio(0.85);
  return { audioContext, analyser, dataArray };
}

function applyAndLaunch() {
  _initDriftPhases();
  if (playState === 'listening' && window.SCENE && window.SCENE._stopMic) window.SCENE._stopMic();
  const seeds = computeSeedValues();
  controlsEl.classList.add('hidden'); controlsEl.classList.remove('visible');

  uniforms.uUnfurl.value = seeds.uUnfurl;
  uniforms.uPondRipple.value = seeds.uPondRipple;
  uniforms.uBreath.value = seeds.uBreath;
  uniforms.uStamen.value = seeds.uStamen;
  uniforms.uNectar.value = seeds.nectar;
  uniforms.uDewPoint.value = seeds.dewPoint;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    uUnfurl: seeds.uUnfurl,
    uPondRipple: seeds.uPondRipple,
    uBreath: seeds.uBreath,
    uStamen: seeds.uStamen
  };
  bakedRootMem = seeds.rootMem;
  bakedPollen = seeds.pollen;
  buildPetals(seeds.layers, seeds.petalsPerRing);
  _lastGeoKey = seeds.layers + "," + seeds.petalsPerRing;
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
  source.loop=true;source.start(0);
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

// Act I:   Seed (0-12%)       — still, almost nothing, a point of potential
// Act II:  Sprout (12-30%)    — first stirrings, reaching upward slowly
// Act III: Bloom (30-60%)     — full opening, all petals spread, color flood
// Act IV:  Radiance (60-80%)  — luminous plateau, gentle swaying peak
// Act V:   Close (80-100%)    — petals curl inward, returning to the mud
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const sm = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const unfurlArc = 0.15
    + 0.15 * sm(0.0, 0.12, p)
    + 0.5  * sm(0.12, 0.4, p)
    + 0.3  * sm(0.4, 0.6, p)
    - 0.15 * sm(0.7, 0.85, p)
    - 0.5  * sm(0.85, 1.0, p);

  const pondArc = 0.8
    - 0.3 * sm(0.1, 0.3, p)
    - 0.3 * sm(0.3, 0.5, p)
    + 0.2 * sm(0.6, 0.8, p)
    + 0.4 * sm(0.85, 1.0, p);

  const breathArc = 0.2
    + 0.2 * sm(0.05, 0.15, p)
    + 0.6 * sm(0.15, 0.45, p)
    + 0.2 * sm(0.45, 0.6, p)
    - 0.3 * sm(0.7, 0.85, p)
    - 0.5 * sm(0.88, 1.0, p);

  const stamenArc = 0.4
    + 0.1 * sm(0.1, 0.25, p)
    + 0.5 * sm(0.25, 0.5, p)
    - 0.1 * sm(0.65, 0.8, p)
    - 0.3 * sm(0.85, 1.0, p);

  const rotArc = 0.3
    + 0.2 * sm(0.1, 0.3, p)
    + 0.5 * sm(0.3, 0.6, p)
    - 0.2 * sm(0.7, 0.85, p)
    - 0.4 * sm(0.88, 1.0, p);

  return {
    uUnfurl:     Math.max(0.1, unfurlArc),
    uPondRipple: Math.max(0.1, pondArc),
    uBreath:     Math.max(0.05, breathArc),
    uStamen:     Math.max(0.2, stamenArc),
    rot:         Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();

const DRIFT_BASE = 108;
const driftCycles = {
  uUnfurl:     { period: DRIFT_BASE * 1.000, depth: 0.30 },
  uPondRipple: { period: DRIFT_BASE * 0.786, depth: 0.35 },
  uBreath:     { period: DRIFT_BASE * 1.272, depth: 0.25 },
  uStamen:     { period: DRIFT_BASE * 0.618, depth: 0.20 },
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { uUnfurl: 1, uPondRipple: 1, uBreath: 1, uStamen: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const songElapsed = audioContext.currentTime - audioStartTime;
    const progress = (songElapsed / audioDuration) % 1;
    const rawArc = storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedRootMem;
    }
  }

  const TWO_PI = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedPollen * 1.4);
    const phase1 = Math.sin(dt * TWO_PI / period + (_dp[key] || 0));
    const phase2 = Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0));
    const drift = (phase1 * 0.65 + phase2 * 0.35) * scaledDepth;
    const arcVal = arcMult[key] || 1;
    uniforms[key].value = Math.max(0.01, seedCenter[key] * arcVal * (1.0 + drift));
  }

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.08;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.04;

  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < 64; i++) {
      const a = i < 2 ? _bassSm : _sceneSm;
      _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i];
      frequencyUniform[i] = _smoothedFreq[i];
    }
  }

  particles.rotation.y = elapsed * rotSpeedY * (arcMult.rot || 1) * (1.0 + rotDrift);
  particles.rotation.x = elapsed * rotSpeedX * (arcMult.rot || 1) * (1.0 + tiltDrift);

  renderer.render(scene, camera);
}

function _vjApply() {
  const seeds = computeSeedValues();
  uniforms.uUnfurl.value = seeds.uUnfurl;
  uniforms.uPondRipple.value = seeds.uPondRipple;
  uniforms.uBreath.value = seeds.uBreath;
  uniforms.uStamen.value = seeds.uStamen;
  uniforms.uNectar.value = seeds.nectar;
  uniforms.uDewPoint.value = seeds.dewPoint;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { uUnfurl: seeds.uUnfurl, uPondRipple: seeds.uPondRipple, uBreath: seeds.uBreath, uStamen: seeds.uStamen };
  bakedRootMem = seeds.rootMem;
  bakedPollen = seeds.pollen;
  const gk = seeds.layers + "," + seeds.petalsPerRing;
  if (gk !== _lastGeoKey) { buildPetals(seeds.layers, seeds.petalsPerRing); _lastGeoKey = gk; }
  _sceneSm = seeds.smoothing;
}

window.SCENE = {
  scene, camera, renderer, uniforms, frequencyUniform, _bassSm, get _sceneSm() { return _sceneSm; },
  get particles() { return particles; },
  get seedCenter() { return seedCenter; },
  get rotSpeedY() { return rotSpeedY; },
  get rotSpeedX() { return rotSpeedX; },
  get bakedArcScale() { return bakedRootMem; },
  get bakedDriftScale() { return bakedPollen; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap: { uUnfurl:'uUnfurl', uPondRipple:'uPondRipple', uBreath:'uBreath', uStamen:'uStamen' },
  rotXMult: 1.0, rotDriftScale: 0.08, tiltDriftScale: 0.04,
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
  sceneName: 'lotus'
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
