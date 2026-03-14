// --- Aevum: Audio-Reactive Strata Visualizer ---
// Concentric spherical shells — geological layers of a planet that crack and glow with sound

const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uLift;
  uniform float uErosion;
  uniform float uTectonics;
  uniform float uFossil;
  uniform float uPatina;
  uniform vec2 uViewport;
  attribute float aLayer;
  attribute float aSpread;
  attribute float aPhase;
  varying float vLayer;
  varying float vFreqAmp;
  varying float vDepth;

  void main() {
    // Each shell reads from frequency bins — inner shells = bass, outer = treble
    float normLayer = aLayer * uFossil;
    int idx = int(clamp(floor(normLayer * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Gate quiet signals
    float gate = uPatina * 0.25 + (1.0 - aLayer) * 0.08;
    float gatedAmp = max(amp - gate, 0.0) / max(1.0 - gate, 0.01);

    // Radial direction from center
    vec3 dir = normalize(position);
    float r = length(position);

    // Radial eruption: shells push outward with audio
    float radialPush = gatedAmp * uLift * (0.3 + aLayer * 0.7);

    // Tangential erosion: particles slide along their shell surface
    vec3 tangent = normalize(cross(dir, vec3(0.0, 1.0, 0.001)));
    vec3 bitangent = normalize(cross(dir, tangent));
    float erode1 = sin(aSpread * 5.0 + uTime * 0.7 + aPhase) * uErosion * gatedAmp * 0.15;
    float erode2 = cos(aPhase * 3.0 + uTime * 0.5) * uErosion * gatedAmp * 0.1;

    // Tectonic warp: deforms the shell non-uniformly
    float warp1 = sin(aSpread * uTectonics * 3.0 + uTime * 0.4) * 0.12;
    float warp2 = cos(aLayer * 8.0 + uTime * 0.3 + aPhase) * 0.08;
    float tecWarp = (warp1 + warp2) * (0.4 + gatedAmp * 1.5);

    vec3 newPos = position;
    // Shells expand outward
    newPos += dir * (radialPush * 0.6 + tecWarp);
    // Tangential erosion slides particles along shell
    newPos += tangent * erode1 + bitangent * erode2;

    // Gentle breathing: shells pulse in and out slowly
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
    vec2 maxNDC = vec2(1.0) - pointRadiusNDC;
    vec2 clamped = clamp(ndc, -maxNDC, maxNDC);
    vec2 overflow = ndc - clamped;
    ndc = clamped - overflow * 0.4;
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

    // Palette: Age shifts between ancient/mineral (0) and molten/active (1)
    // Bottom strata: deep earth tones; top strata: sky/ice
    vec3 deepOld   = vec3(0.15, 0.08, 0.05);
    vec3 deepNew   = vec3(0.40, 0.08, 0.03);
    vec3 midOld    = vec3(0.25, 0.18, 0.12);
    vec3 midNew    = vec3(0.60, 0.30, 0.08);
    vec3 upperOld  = vec3(0.18, 0.25, 0.35);
    vec3 upperNew  = vec3(0.35, 0.50, 0.30);
    vec3 skyOld    = vec3(0.30, 0.40, 0.55);
    vec3 skyNew    = vec3(0.70, 0.55, 0.25);

    vec3 deep  = mix(deepOld, deepNew, uAge);
    vec3 mid   = mix(midOld, midNew, uAge);
    vec3 upper = mix(upperOld, upperNew, uAge);
    vec3 sky   = mix(skyOld, skyNew, uAge);

    float l = vLayer;
    vec3 color;
    if (l < 0.25) {
      color = mix(deep, mid, l / 0.25);
    } else if (l < 0.5) {
      color = mix(mid, upper, (l - 0.25) / 0.25);
    } else if (l < 0.75) {
      color = mix(upper, sky, (l - 0.5) / 0.25);
    } else {
      color = mix(sky, sky * 1.3, (l - 0.75) / 0.25);
    }

    // Audio brightens — veins of light through the rock
    color = mix(color, color * 2.0 + vec3(0.05, 0.03, 0.01), vFreqAmp * 0.4);

    // Layer-based alpha: middle strata more opaque, edges ethereal
    float layerAlpha = mix(0.5, 0.8, 1.0 - abs(vLayer * 2.0 - 1.0));
    alpha *= layerAlpha * (0.4 + vFreqAmp * 0.6);

    gl_FragColor = vec4(color, alpha);
  }
`;

// --- Scene Setup ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.3, 4.5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// --- Shader Uniforms ---
const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime: { value: 0.0 },
  uLift: { value: 1.2 },
  uErosion: { value: 0.5 },
  uTectonics: { value: 2.0 },
  uFossil: { value: 0.7 },
  uAge: { value: 0.5 },
  uPatina: { value: 0.5 },
  uViewport: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
};

// --- Seed Parameters ---
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

// Randomize on page load
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
  const epoch   = sliders.p1.value / 100;  // Epoch — vertical reactivity
  const drift   = sliders.p2.value / 100;  // Drift — rotation/wander
  const fault   = sliders.p3.value / 100;  // Fault Line — tectonic warp intensity
  const stratum = sliders.p4.value / 100;  // Stratum — layer count/complexity

  // Fault amplifies epoch (pressure creates eruption)
  const effectiveEpoch = epoch * (1.0 + fault * 0.5);
  // Fault dampens drift (locked plates don't wander)
  const effectiveDrift = drift * (1.0 - fault * 0.25);

  const lift = 0.3 + effectiveEpoch * 2.5;
  const erosion = 0.1 + effectiveDrift * 1.2;
  const tectonics = 0.5 + fault * 4.5;
  const waveSpeed = 0.3 + drift * 3.0;

  const rotSpeedY = 0.03 + effectiveDrift * 0.35;
  const rotSpeedX = 0.02 + effectiveDrift * 0.15;
  const smoothing = 0.92 - fault * 0.6;

  const detail = Math.floor(4 + stratum * 35);
  const fossil = 0.4 + stratum * 0.6;

  return {
    lift, erosion, tectonics, fossil, waveSpeed, rotSpeedY, rotSpeedX, smoothing, detail,
    age: sliders.p5.value / 100,
    memory: sliders.p6.value / 100,
    patina: sliders.p7.value / 100,
    sediment: sliders.p8.value / 100
  };
}

// --- Particle Shells ---
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
    // Each shell is a sphere at a certain radius — inner = core, outer = crust
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

// --- Baked seed centers ---
let rotSpeedY = 0.08;
let rotSpeedX = 0.04;
let bakedMemory = 0.5;
let bakedSediment = 0.5;
let seedCenter = {
  lift: 1.2,
  erosion: 0.5,
  tectonics: 2.0,
  fossil: 0.7,
  waveSpeed: 1.5
};

// --- Audio Setup ---
let audioContext = null;
let analyser = null;
let dataArray = null;
let source = null;
let audioDuration = 0;
let audioStartTime = 0;

function initAudio(smoothing) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = smoothing;
  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

// --- File Input Handler ---
let currentBuffer = null, currentFileName = '';
let playState = 'idle';
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

playBtn.addEventListener('click', () => {
  if (!currentBuffer) return;

  const seeds = computeSeedValues();
  controlsEl.classList.add('hidden');
  controlsEl.classList.remove('visible');

  uniforms.uLift.value = seeds.lift;
  uniforms.uErosion.value = seeds.erosion;
  uniforms.uTectonics.value = seeds.tectonics;
  uniforms.uFossil.value = seeds.fossil;
  uniforms.uAge.value = seeds.age;
  uniforms.uPatina.value = seeds.patina;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    lift: seeds.lift,
    erosion: seeds.erosion,
    tectonics: seeds.tectonics,
    fossil: seeds.fossil,
    waveSpeed: seeds.waveSpeed
  };
  bakedMemory = seeds.memory;
  bakedSediment = seeds.sediment;
  buildParticles(seeds.detail);
  analyser.smoothingTimeConstant = seeds.smoothing;

  if (playState === 'paused') {
    audioContext.resume();
    playState = 'playing';
    return;
  }

  if (source) { try { source.stop(); } catch(e){} source.disconnect(); }
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

// --- Canvas click: pause / resume ---
renderer.domElement.addEventListener('click', () => {
  if (playState === 'playing') {
    audioContext.suspend();
    playState = 'paused';
    playBtn.textContent = '\u25b6\uFE0E Resume';
    controlsEl.classList.add('visible');
    controlsEl.classList.remove('hidden');
  }
});

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  uniforms.uViewport.value.set(window.innerWidth, window.innerHeight);
});

// --- Narrative Arc: Aevum story ---
// Act I:   Formation (0-15%)   — dark, dense, barely moving
// Act II:  Upheaval  (15-40%)  — strata begin to crack and rise
// Act III: Eruption  (40-60%)  — full tectonic violence, layers apart
// Act IV:  Cooling   (60-82%)  — settling, hardening into new forms
// Act V:   Fossil    (82-100%) — stillness, only faint mineral glow
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));

  const sm = (edge0, edge1, x) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  const liftArc = 0.2
    + 0.2 * sm(0.0, 0.15, p)
    + 0.8 * sm(0.15, 0.45, p)
    - 0.3 * sm(0.60, 0.82, p)
    - 0.5 * sm(0.82, 1.0, p);

  const erosionArc = 0.3
    + 0.15 * sm(0.05, 0.2, p)
    + 0.6 * sm(0.2, 0.5, p)
    - 0.2 * sm(0.55, 0.75, p)
    - 0.5 * sm(0.8, 1.0, p);

  const tectonicsArc = 0.3
    + 0.1 * sm(0.1, 0.25, p)
    + 0.7 * sm(0.25, 0.50, p)
    - 0.15 * sm(0.55, 0.7, p)
    + 0.1 * sm(0.7, 0.8, p)
    - 0.6 * sm(0.82, 1.0, p);

  const fossilArc = 0.5
    + 0.15 * sm(0.05, 0.2, p)
    + 0.35 * sm(0.2, 0.5, p)
    - 0.1 * sm(0.6, 0.75, p)
    - 0.35 * sm(0.8, 1.0, p);

  const waveSpeedArc = 0.3
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
    lift: Math.max(0.1, liftArc),
    erosion: Math.max(0.05, erosionArc),
    tectonics: Math.max(0.2, tectonicsArc),
    fossil: Math.max(0.2, fossilArc),
    waveSpeed: Math.max(0.1, waveSpeedArc),
    rot: Math.max(0.1, rotArc)
  };
}

// --- Render Loop ---
const clock = new THREE.Clock();

const DRIFT_BASE = 240;
const driftCycles = {
  lift:       { period: DRIFT_BASE * 1.000, depth: 0.30 },
  erosion:    { period: DRIFT_BASE * 0.786, depth: 0.35 },
  tectonics:  { period: DRIFT_BASE * 1.272, depth: 0.30 },
  fossil:     { period: DRIFT_BASE * 1.618, depth: 0.20 },
  waveSpeed:  { period: DRIFT_BASE * 0.618, depth: 0.35 },
};

// Map internal key to uniform name
const uniformMap = {
  lift: 'uLift',
  erosion: 'uErosion',
  tectonics: 'uTectonics',
  fossil: 'uFossil',
  waveSpeed: 'uTectonics' // waveSpeed modulates tectonics over time
};

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  // --- Song narrative arc (shaped by Memory) ---
  let arcMult = { lift: 1, erosion: 1, tectonics: 1, fossil: 1, waveSpeed: 1, rot: 1 };
  if (audioDuration > 0 && audioStartTime > 0) {
    const songElapsed = audioContext.currentTime - audioStartTime;
    const progress = Math.min(songElapsed / audioDuration, 1.0);
    const rawArc = storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedMemory;
    }
  }

  // --- Slow drift ---
  const TWO_PI = Math.PI * 2;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedSediment * 1.4);
    const phase1 = Math.sin(elapsed * TWO_PI / period);
    const phase2 = Math.sin(elapsed * TWO_PI / (period * 2.17) + 1.3);
    const drift = (phase1 * 0.65 + phase2 * 0.35) * scaledDepth;

    // Apply to the correct uniform
    const uName = key === 'waveSpeed' ? 'uTectonics' : ('u' + key.charAt(0).toUpperCase() + key.slice(1));
    if (key !== 'waveSpeed') {
      uniforms[uName].value = Math.max(0.01, seedCenter[key] * arcMult[key] * (1.0 + drift));
    }
  }

  // Rotation drift
  const rotDrift = Math.sin(elapsed * TWO_PI / (DRIFT_BASE * 0.92)) * 0.12;
  const tiltDrift = Math.sin(elapsed * TWO_PI / (DRIFT_BASE * 1.38) + 2.0) * 0.08;

  // Read frequency data
  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < 64; i++) {
      frequencyUniform[i] = dataArray[i];
    }
  }

  // Rotate gently — strata turn slowly, like examining a core sample
  particles.rotation.y = elapsed * rotSpeedY * (arcMult.rot || 1) * (1.0 + rotDrift);
  particles.rotation.x = elapsed * rotSpeedX * 0.3 * (arcMult.rot || 1) * (1.0 + tiltDrift);

  renderer.render(scene, camera);
}

// --- Recorder API ---
window.SCENE = {
  scene, camera, renderer, uniforms, frequencyUniform,
  get particles() { return particles; },
  get seedCenter() { return seedCenter; },
  get rotSpeedY() { return rotSpeedY; },
  get rotSpeedX() { return rotSpeedX; },
  get bakedArcScale() { return bakedMemory; },
  get bakedDriftScale() { return bakedSediment; },
  driftCycles, DRIFT_BASE,
  uniformMap,
  rotXMult: 0.3, rotDriftScale: 0.12, tiltDriftScale: 0.08,
  storyArc,
  get currentBuffer() { return currentBuffer; },
  get audioDuration() { return audioDuration; },
  get audioContext() { return audioContext; },
  get analyser() { return analyser; },
  get playState() { return playState; },
  sceneName: 'aevum'
};

animate();
