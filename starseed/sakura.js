const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uBloom;
  uniform float uFall;
  uniform float uBreath;
  uniform float uBranch;
  uniform float uFrost;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aPetalLayer;
  attribute float aPetalAngle;
  attribute float aPetalPos;
  attribute float aFallSeed;
  varying float vLayer;
  varying float vFreqAmp;
  varying float vCurl;
  varying float vFalling;
  const float VIS_INPUT_GAIN = 0.63095734; // -4 dB visual attenuation

  void main() {
    // Each branch cluster reads from a frequency bin (inner=bass, outer=treble)
    float normLayer = aPetalLayer * uBranch;
    int idx = int(clamp(floor(normLayer * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Gate quiet signals — frost threshold
    float gate = uFrost * 0.2 + (1.0 - aPetalLayer) * 0.1;
    float gatedAmp = (max(amp - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Five-petal bloom: outer clusters open wider with audio
    float openAmount = gatedAmp * uBloom * aPetalLayer;
    float curl = openAmount * 0.7;

    // Vertical breath: inner branches lift higher
    float rise = gatedAmp * (1.0 - aPetalLayer * 0.5) * uBreath;

    // Hanafubuki (petal fall): audio-reactive falling with parabolic gravity
    float fallTrigger = smoothstep(0.3, 0.8, gatedAmp) * uFall;
    float fallPhase = fract(aFallSeed + uTime * 0.04 * (0.5 + uFall * 0.5));
    float fallActive = fallTrigger * step(0.6, aFallSeed);
    float fallY = -fallPhase * fallPhase * 3.0 * fallActive;
    float fallX = sin(fallPhase * 6.28 + aFallSeed * 12.0) * 0.8 * fallActive;
    float fallZ = cos(fallPhase * 4.0 + aFallSeed * 8.0) * 0.4 * fallActive;
    // Tumble rotation for falling petals
    float tumble = sin(uTime * 2.0 + aFallSeed * 20.0) * 0.15 * fallActive;

    vec3 newPos = position;
    newPos.y += rise * 0.5 + fallY + tumble;
    newPos.x += newPos.x * curl * 0.3 + fallX;
    newPos.z += newPos.z * curl * 0.3 + fallZ;
    // Gentle branch sway in wind
    newPos.x += sin(uTime * 0.4 + aPetalAngle + aPetalLayer * 2.0) * 0.03 * (1.0 + gatedAmp);
    newPos.z += cos(uTime * 0.3 + aPetalAngle * 0.7) * 0.02;

    vLayer = aPetalLayer;
    vFreqAmp = gatedAmp;
    vCurl = curl;
    vFalling = fallActive;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Point size: delicate at rest, swells with audio
    float baseSize = mix(0.5, 1.3, aPetalLayer);
    float fallShrink = 1.0 - fallActive * 0.3;
    gl_PointSize = (baseSize + gatedAmp * 3.0) * fallShrink * (280.0 / -mvPos.z) * step(0.005, gatedAmp + fallActive * 0.5) + 0.8;

    // Viewport constraint — boundary-aware clamping
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
  varying float vFalling;
  uniform float uSeason;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Soft organic falloff — slightly sharper than lotus for crisper petals
    float alpha = 1.0 - smoothstep(0.12, 0.5, dist);

    // Sakura palette: Season shifts between pale spring (0) and deep twilight (1)
    // Inner: white-pink, Mid: soft pink, Outer: rose-magenta, Deep: dark branch
    vec3 innerSpring = vec3(0.98, 0.92, 0.94);
    vec3 innerDeep   = vec3(0.95, 0.80, 0.85);
    vec3 midSpring   = vec3(0.95, 0.65, 0.75);
    vec3 midDeep     = vec3(0.85, 0.40, 0.55);
    vec3 outerSpring = vec3(0.80, 0.35, 0.50);
    vec3 outerDeep   = vec3(0.60, 0.15, 0.35);
    vec3 deepSpring  = vec3(0.30, 0.15, 0.20);
    vec3 deepDeep    = vec3(0.20, 0.05, 0.12);

    vec3 inner = mix(innerSpring, innerDeep, uSeason);
    vec3 mid   = mix(midSpring, midDeep, uSeason);
    vec3 outer = mix(outerSpring, outerDeep, uSeason);
    vec3 deep  = mix(deepSpring, deepDeep, uSeason);

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

    // Audio brightens toward white-pink at peaks
    color = mix(color, inner, vFreqAmp * 0.4);

    // Falling petals get slightly more transparent and warmer
    color = mix(color, midSpring, vFalling * 0.2);

    // Inner more opaque, outer more ethereal, falling petals fade
    alpha *= mix(0.7, 0.3, vLayer);
    alpha *= 0.45 + vFreqAmp * 0.55;
    alpha *= 1.0 - vFalling * 0.25;

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
  uBloom: { value: 1.2 },
  uFall: { value: 0.5 },
  uBreath: { value: 1.0 },
  uBranch: { value: 0.7 },
  uSeason: { value: 0.5 },
  uFrost: { value: 0.5 },
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
  const bloom   = sliders.p1.value / 100;
  const fall    = sliders.p2.value / 100;
  const breath  = sliders.p3.value / 100;
  const branch  = sliders.p4.value / 100;
  const season  = sliders.p5.value / 100;
  const aware   = sliders.p6.value / 100;   // mono no aware — arc intensity
  const frost   = sliders.p7.value / 100;
  const kaze    = sliders.p8.value / 100;    // wind — drift

  // Breath deepens bloom (breathing opens blossoms wider)
  const effectiveBloom = bloom * (1.0 + breath * 0.4);
  // Fall dampens breath (falling petals calm the sway)
  const effectiveBreath = breath * (1.0 - fall * 0.2);
  // Branch complexity scales with bloom
  const effectiveBranch = branch * (0.6 + effectiveBloom * 0.4);

  const uBloom = 0.3 + effectiveBloom * 2.0;
  const uFall = 0.1 + fall * 1.5;
  const uBreath = 0.2 + effectiveBreath * 2.5;
  const uBranch = 0.3 + effectiveBranch * 0.7;

  const layers = Math.floor(5 + branch * 25);
  const petalsPerRing = Math.floor(8 + bloom * 20);

  const smoothing = 0.7 + fall * 0.25;

  const rotSpeedY = 0.02 + bloom * 0.06 + kaze * 0.08;
  const rotSpeedX = 0.005 + kaze * 0.02;

  return {
    uBloom, uFall, uBreath, uBranch,
    season, aware, frost, kaze,
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
  const fallSeeds = [];

  const GOLDEN_ANGLE = Math.PI * (3.0 - Math.sqrt(5.0)); // ~137.5 degrees

  for (let l = 0; l < layers; l++) {
    const layerNorm = l / layers;
    // Spiral branch placement using golden angle (phyllotaxis)
    const branchAngle = l * GOLDEN_ANGLE;
    const radius = 0.12 + layerNorm * 1.9;
    // Branches droop slightly outward, inner ones sit higher
    const baseY = (1.0 - layerNorm) * 0.3 - layerNorm * 0.1;
    const ptsInRing = Math.floor(petalsPerRing * (0.3 + layerNorm * 0.7));

    for (let p = 0; p < ptsInRing; p++) {
      // Five-fold symmetry: petals arranged in groups of 5
      const petalGroup = Math.floor(p / 5);
      const petalInGroup = p % 5;
      const groupAngle = (petalGroup / Math.ceil(ptsInRing / 5)) * Math.PI * 2 + branchAngle;
      // Each petal in the five-fold cluster offset by 72 degrees (2*PI/5)
      const petalOffset = petalInGroup * (Math.PI * 2 / 5);
      const angle = groupAngle + petalOffset * 0.15; // subtle 5-fold spread

      const steps = 3;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const r = radius + t * (1.9 / layers) * 0.7;
        // Sakura petal shape: slightly asymmetric — one side rounder
        const asymmetry = Math.sin(petalOffset + layerNorm * 3.0) * 0.06;
        const x = Math.cos(angle) * r + asymmetry;
        const z = Math.sin(angle) * r;
        const y = baseY + t * layerNorm * 0.12;
        positions.push(x, y, z);
        petalLayers.push(layerNorm);
        petalAngles.push(angle);
        petalPositions.push(t);
        // Fall seed: random value determines which petals can fall
        fallSeeds.push(Math.random());
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aPetalLayer', new THREE.Float32BufferAttribute(petalLayers, 1));
  geometry.setAttribute('aPetalAngle', new THREE.Float32BufferAttribute(petalAngles, 1));
  geometry.setAttribute('aPetalPos', new THREE.Float32BufferAttribute(petalPositions, 1));
  geometry.setAttribute('aFallSeed', new THREE.Float32BufferAttribute(fallSeeds, 1));

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
let bakedAware = 0.55;
let bakedKaze = 0.4;
let seedCenter = {
  uBloom: 1.2,
  uFall: 0.5,
  uBreath: 1.0,
  uBranch: 0.7
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

  uniforms.uBloom.value = seeds.uBloom;
  uniforms.uFall.value = seeds.uFall;
  uniforms.uBreath.value = seeds.uBreath;
  uniforms.uBranch.value = seeds.uBranch;
  uniforms.uSeason.value = seeds.season;
  uniforms.uFrost.value = seeds.frost;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    uBloom: seeds.uBloom,
    uFall: seeds.uFall,
    uBreath: seeds.uBreath,
    uBranch: seeds.uBranch
  };
  bakedAware = seeds.aware;
  bakedKaze = seeds.kaze;
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

// Act I:   Bud (0-12%)        — frost-still, tiny green promise
// Act II:  First Bloom (12-30%) — petals unfolding, colour swelling
// Act III: Full Bloom (30-55%)  — hanami glory, all branches open, petals begin to fall
// Act IV:  Scattering (55-80%)  — hanafubuki, petals everywhere, bittersweet peak
// Act V:   Bare Branch (80-100%) — emptying, quiet beauty of what remains
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const sm = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const bloomArc = 0.15
    + 0.15 * sm(0.0, 0.12, p)
    + 0.5  * sm(0.12, 0.35, p)
    + 0.25 * sm(0.35, 0.55, p)
    - 0.2  * sm(0.6, 0.8, p)
    - 0.45 * sm(0.82, 1.0, p);

  // Fall increases through mid-to-late song, peaks during scattering
  const fallArc = 0.1
    + 0.1 * sm(0.2, 0.35, p)
    + 0.5 * sm(0.35, 0.55, p)
    + 0.3 * sm(0.55, 0.75, p)
    - 0.3 * sm(0.8, 0.95, p)
    - 0.4 * sm(0.95, 1.0, p);

  const breathArc = 0.2
    + 0.2 * sm(0.05, 0.15, p)
    + 0.6 * sm(0.15, 0.4, p)
    + 0.15 * sm(0.4, 0.55, p)
    - 0.25 * sm(0.65, 0.82, p)
    - 0.45 * sm(0.85, 1.0, p);

  const branchArc = 0.4
    + 0.1  * sm(0.1, 0.25, p)
    + 0.45 * sm(0.25, 0.5, p)
    - 0.1  * sm(0.65, 0.8, p)
    - 0.3  * sm(0.85, 1.0, p);

  const rotArc = 0.3
    + 0.2 * sm(0.1, 0.3, p)
    + 0.5 * sm(0.3, 0.6, p)
    - 0.2 * sm(0.7, 0.85, p)
    - 0.4 * sm(0.88, 1.0, p);

  return {
    uBloom:  Math.max(0.1, bloomArc),
    uFall:   Math.max(0.05, fallArc),
    uBreath: Math.max(0.05, breathArc),
    uBranch: Math.max(0.2, branchArc),
    rot:     Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();

const DRIFT_BASE = 108;
const driftCycles = {
  uBloom:  { period: DRIFT_BASE * 1.000, depth: 0.30 },
  uFall:   { period: DRIFT_BASE * 0.786, depth: 0.35 },
  uBreath: { period: DRIFT_BASE * 1.272, depth: 0.25 },
  uBranch: { period: DRIFT_BASE * 0.618, depth: 0.20 },
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { uBloom: 1, uFall: 1, uBreath: 1, uBranch: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) {
    const songElapsed = audioContext.currentTime - audioStartTime;
    const progress = (songElapsed / audioDuration) % 1;
    const rawArc = storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * bakedAware;
    }
  }

  const TWO_PI = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const key in driftCycles) {
    const { period, depth } = driftCycles[key];
    const scaledDepth = depth * (0.3 + bakedKaze * 1.4);
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
  uniforms.uBloom.value = seeds.uBloom;
  uniforms.uFall.value = seeds.uFall;
  uniforms.uBreath.value = seeds.uBreath;
  uniforms.uBranch.value = seeds.uBranch;
  uniforms.uSeason.value = seeds.season;
  uniforms.uFrost.value = seeds.frost;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { uBloom: seeds.uBloom, uFall: seeds.uFall, uBreath: seeds.uBreath, uBranch: seeds.uBranch };
  bakedAware = seeds.aware;
  bakedKaze = seeds.kaze;
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
  get bakedArcScale() { return bakedAware; },
  get bakedDriftScale() { return bakedKaze; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap: { uBloom:'uBloom', uFall:'uFall', uBreath:'uBreath', uBranch:'uBranch' },
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
  sceneName: 'sakura'
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
