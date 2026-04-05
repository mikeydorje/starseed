const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uBond;
  uniform float uSymmetry;
  uniform float uResonance;
  uniform float uFacet;
  uniform float uClarity;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aNode;
  attribute float aAxis;
  attribute float aPhase;
  varying float vNode;
  varying float vFreqAmp;
  varying float vAxis;

  void main() {
    // Each grid node reads from frequency bins spread across the lattice
    float normNode = aNode * uFacet;
    int idx = int(clamp(floor(normNode * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;

    // Gate
    float gate = uClarity * 0.3;
    float gatedAmp = max(amp - gate, 0.0) / max(1.0 - gate, 0.01);

    // Displacement along grid axes — creates breathing crystal effect
    float axisDisp = gatedAmp * uBond * 0.35;
    // Axis-aligned vibration — particles move along their dominant placement axis
    float vibX = sin(position.x * uSymmetry * 2.0 + uTime * 1.5 + aPhase) * axisDisp;
    float vibY = cos(position.y * uSymmetry * 2.0 + uTime * 1.2 - aNode * 3.0) * axisDisp;
    float vibZ = sin(position.z * uSymmetry * 1.5 + uTime * 0.9 + aPhase * 2.0) * axisDisp * 0.7;

    // Resonance: standing wave patterns through the lattice
    float standingWave = sin(position.x * 3.14 + position.y * 2.0 + uTime * uResonance * 0.8) *
                         cos(position.z * 2.5 + uTime * uResonance * 0.5);
    float resonanceDisp = standingWave * gatedAmp * uResonance * 0.12;

    vec3 newPos = position;
    newPos.x += vibX + resonanceDisp;
    newPos.y += vibY + resonanceDisp * 0.7;
    newPos.z += vibZ;
    // Subtle lattice-wide breathing
    float breath = sin(uTime * 0.2 + aNode * 1.5) * 0.015;
    newPos *= 1.0 + breath;

    vNode = aNode;
    vFreqAmp = gatedAmp;
    vAxis = aAxis;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);

    // Sharp small points — crisp crystalline
    float baseSize = 0.9;
    gl_PointSize = (baseSize + gatedAmp * 1.6) * (190.0 / -mvPos.z) * step(0.005, gatedAmp) + 0.7;

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
  varying float vNode;
  varying float vFreqAmp;
  varying float vAxis;
  uniform float uLustre;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Sharp crystalline edge
    float alpha = 1.0 - smoothstep(0.12, 0.40, dist);
    // Minimal halo — accent only
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.07;

    // Palette: Lustre shifts mineral/silver (0) to warm/metallic (1)
    vec3 coolNode  = vec3(0.55, 0.60, 0.75);
    vec3 coolEdge  = vec3(0.30, 0.35, 0.55);
    vec3 warmNode  = vec3(0.75, 0.55, 0.35);
    vec3 warmEdge  = vec3(0.55, 0.35, 0.25);
    vec3 coolPeak  = vec3(0.85, 0.90, 0.95);
    vec3 warmPeak  = vec3(0.95, 0.85, 0.65);

    vec3 node = mix(coolNode, warmNode, uLustre);
    vec3 edge = mix(coolEdge, warmEdge, uLustre);
    vec3 peak = mix(coolPeak, warmPeak, uLustre);

    // Color varies by axis alignment and node position
    vec3 color = mix(edge, node, vAxis);
    // Audio drives toward bright peak
    color = mix(color, peak, vFreqAmp * 0.6);
    // Node variation gives depth
    color += vec3(sin(vNode * 8.0) * 0.04, cos(vNode * 5.0) * 0.03, sin(vNode * 3.0) * 0.05);

    // Sharp alpha
    alpha *= 0.72 + vFreqAmp * 0.28;
    alpha += halo;

    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.3, 5.0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform },
  uTime: { value: 0.0 },
  uBond: { value: 1.2 },
  uSymmetry: { value: 2.0 },
  uResonance: { value: 1.5 },
  uFacet: { value: 0.7 },
  uLustre: { value: 0.5 },
  uClarity: { value: 0.5 },
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
  const bond     = sliders.p1.value / 100;
  const symmetry = sliders.p2.value / 100;
  const facet    = sliders.p3.value / 100;
  const resonance = sliders.p4.value / 100;

  // Resonance amplifies bond (vibration loosens crystal)
  const effectiveBond = bond * (1.0 + resonance * 0.4);
  // Symmetry dampens resonance (perfect crystal absorbs waves)
  const effectiveResonance = resonance * (1.0 - symmetry * 0.2);

  return {
    bond: 0.3 + effectiveBond * 2.5,
    symmetry: 0.5 + symmetry * 4.0,
    resonance: 0.3 + effectiveResonance * 3.0,
    facet: 0.3 + facet * 0.7,
    rotSpeedY: 0.02 + bond * 0.15,
    rotSpeedX: 0.01 + bond * 0.08,
    smoothing: 0.90 - resonance * 0.5,
    detail: Math.floor(4 + facet * 30),
    lustre: sliders.p5.value / 100,
    memory: sliders.p6.value / 100,
    clarity: sliders.p7.value / 100,
    shimmer: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) {
    scene.remove(particles);
    particles.geometry.dispose();
  }

  // Irregular 3D lattice — not centered, spans the space
  const gridSize = Math.floor(3 + detail * 0.25);
  const spacing = 3.6 / gridSize;
  const positions = [];
  const nodeAttrs = [];
  const axisAttrs = [];
  const phaseAttrs = [];

  let totalNodes = 0;

  for (let ix = 0; ix < gridSize; ix++) {
    for (let iy = 0; iy < gridSize; iy++) {
      for (let iz = 0; iz < gridSize; iz++) {
        // Base grid position — offset so it's not centered on origin perfectly
        const bx = (ix - (gridSize - 1) / 2) * spacing + 0.15;
        const by = (iy - (gridSize - 1) / 2) * spacing - 0.1;
        const bz = (iz - (gridSize - 1) / 2) * spacing;

        // Irregularity: displace nodes from perfect grid
        const jitter = spacing * 0.25;
        const x = bx + (Math.random() - 0.5) * jitter;
        const y = by + (Math.random() - 0.5) * jitter;
        const z = bz + (Math.random() - 0.5) * jitter;

        // Skip ~15% of nodes for organic gaps
        if (Math.random() < 0.15) continue;

        const nodeNorm = totalNodes / (gridSize * gridSize * gridSize);
        // Axis affinity: which axis this node vibrates along most
        const axisAffinity = (ix + iy + iz) % 3 / 2;

        positions.push(x, y, z);
        nodeAttrs.push(nodeNorm);
        axisAttrs.push(axisAffinity);
        phaseAttrs.push(Math.random() * Math.PI * 2);

        // Add edge particles between this node and neighbors (sparse)
        if (Math.random() < 0.6 && ix < gridSize - 1) {
          const nx = bx + spacing * 0.5 + (Math.random() - 0.5) * jitter * 0.5;
          const ny = y + (Math.random() - 0.5) * jitter * 0.3;
          const nz = z + (Math.random() - 0.5) * jitter * 0.3;
          positions.push(nx, ny, nz);
          nodeAttrs.push(nodeNorm);
          axisAttrs.push(0.1);
          phaseAttrs.push(Math.random() * Math.PI * 2);
        }
        if (Math.random() < 0.6 && iy < gridSize - 1) {
          const nx = x + (Math.random() - 0.5) * jitter * 0.3;
          const ny = by + spacing * 0.5 + (Math.random() - 0.5) * jitter * 0.5;
          const nz = z + (Math.random() - 0.5) * jitter * 0.3;
          positions.push(nx, ny, nz);
          nodeAttrs.push(nodeNorm);
          axisAttrs.push(0.5);
          phaseAttrs.push(Math.random() * Math.PI * 2);
        }
        if (Math.random() < 0.6 && iz < gridSize - 1) {
          const nx = x + (Math.random() - 0.5) * jitter * 0.3;
          const ny = y + (Math.random() - 0.5) * jitter * 0.3;
          const nz = bz + spacing * 0.5 + (Math.random() - 0.5) * jitter * 0.5;
          positions.push(nx, ny, nz);
          nodeAttrs.push(nodeNorm);
          axisAttrs.push(0.9);
          phaseAttrs.push(Math.random() * Math.PI * 2);
        }

        totalNodes++;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aNode', new THREE.Float32BufferAttribute(nodeAttrs, 1));
  geometry.setAttribute('aAxis', new THREE.Float32BufferAttribute(axisAttrs, 1));
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

let rotSpeedY = 0.04;
let rotSpeedX = 0.02;
let bakedMemory = 0.5;
let bakedShimmer = 0.5;
let seedCenter = {
  bond: 1.2,
  symmetry: 2.0,
  resonance: 1.5,
  facet: 0.7
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

  uniforms.uBond.value = seeds.bond;
  uniforms.uSymmetry.value = seeds.symmetry;
  uniforms.uResonance.value = seeds.resonance;
  uniforms.uFacet.value = seeds.facet;
  uniforms.uLustre.value = seeds.lustre;
  uniforms.uClarity.value = seeds.clarity;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;

  seedCenter = {
    bond: seeds.bond,
    symmetry: seeds.symmetry,
    resonance: seeds.resonance,
    facet: seeds.facet
  };
  bakedMemory = seeds.memory;
  bakedShimmer = seeds.shimmer;
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

// Act I:   Still (0-14%)       — crystal at rest, faint presence
// Act II:  Vibrate (14-35%)    — bonds begin to oscillate, nodes stir
// Act III: Fracture (35-58%)   — lattice distorts, maximum displacement
// Act IV:  Resonate (58-80%)   — standing waves stabilize, harmonic patterns
// Act V:   Crystallize (80-100%) — settle into new equilibrium, fade
function storyArc(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const sm = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const bondArc = 0.2
    + 0.15 * sm(0.0, 0.14, p)
    + 0.7  * sm(0.14, 0.45, p)
    - 0.2  * sm(0.58, 0.78, p)
    - 0.5  * sm(0.80, 1.0, p);

  const symmetryArc = 0.7
    - 0.15 * sm(0.1, 0.3, p)
    - 0.4  * sm(0.3, 0.5, p)
    + 0.25 * sm(0.58, 0.75, p)
    + 0.3  * sm(0.8, 1.0, p);

  const resonanceArc = 0.2
    + 0.2  * sm(0.1, 0.25, p)
    + 0.6  * sm(0.25, 0.5, p)
    + 0.1  * sm(0.5, 0.65, p)
    - 0.3  * sm(0.7, 0.85, p)
    - 0.5  * sm(0.85, 1.0, p);

  const facetArc = 0.4
    + 0.2  * sm(0.05, 0.2, p)
    + 0.4  * sm(0.2, 0.5, p)
    - 0.1  * sm(0.6, 0.78, p)
    - 0.35 * sm(0.8, 1.0, p);

  const rotArc = 0.3
    + 0.15 * sm(0.1, 0.28, p)
    + 0.55 * sm(0.28, 0.55, p)
    - 0.2  * sm(0.65, 0.82, p)
    - 0.4  * sm(0.85, 1.0, p);

  return {
    bond:      Math.max(0.1, bondArc),
    symmetry:  Math.max(0.3, symmetryArc),
    resonance: Math.max(0.1, resonanceArc),
    facet:     Math.max(0.2, facetArc),
    rot:       Math.max(0.1, rotArc)
  };
}

const clock = new THREE.Clock();

const DRIFT_BASE = 108;
const driftCycles = {
  bond:      { period: DRIFT_BASE * 1.000, depth: 0.30 },
  symmetry:  { period: DRIFT_BASE * 1.272, depth: 0.25 },
  resonance: { period: DRIFT_BASE * 0.786, depth: 0.35 },
  facet:     { period: DRIFT_BASE * 0.618, depth: 0.20 },
};

const uniformMap = {
  bond:      'uBond',
  symmetry:  'uSymmetry',
  resonance: 'uResonance',
  facet:     'uFacet'
};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  uniforms.uTime.value = elapsed;

  let arcMult = { bond: 1, symmetry: 1, resonance: 1, facet: 1, rot: 1 };
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
    const scaledDepth = depth * (0.3 + bakedShimmer * 1.4);
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

  const rotDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 0.92) + (_dp._rd || 0)) * 0.05;
  const tiltDrift = Math.sin(dt * TWO_PI / (DRIFT_BASE * 1.38) + 2.0 + (_dp._td || 0)) * 0.03;

  particles.rotation.y = elapsed * rotSpeedY * (arcMult.rot || 1) * (1.0 + rotDrift);
  particles.rotation.x = elapsed * rotSpeedX * (arcMult.rot || 1) * (1.0 + tiltDrift);

  renderer.render(scene, camera);
}

function _vjApply() {
  const seeds = computeSeedValues();
  uniforms.uBond.value = seeds.bond;
  uniforms.uSymmetry.value = seeds.symmetry;
  uniforms.uResonance.value = seeds.resonance;
  uniforms.uFacet.value = seeds.facet;
  uniforms.uLustre.value = seeds.lustre;
  uniforms.uClarity.value = seeds.clarity;
  rotSpeedY = seeds.rotSpeedY;
  rotSpeedX = seeds.rotSpeedX;
  seedCenter = { bond: seeds.bond, symmetry: seeds.symmetry, resonance: seeds.resonance, facet: seeds.facet };
  bakedMemory = seeds.memory;
  bakedShimmer = seeds.shimmer;
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
  get bakedDriftScale() { return bakedShimmer; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap,
  rotXMult: 1.0, rotDriftScale: 0.05, tiltDriftScale: 0.03,
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
  sceneName: 'lattice'
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
