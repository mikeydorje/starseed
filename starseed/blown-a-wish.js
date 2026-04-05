const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uScatter;
  uniform float uBreeze;
  uniform float uLift;
  uniform float uEphemeral;
  uniform float uThreshold;
  uniform vec2 uViewport;
  uniform float uBoundary;
  uniform float uEnvelope;
  attribute float aNode;
  attribute float aPhase;
  attribute float aSize;
  attribute float aTrajectory;
  varying float vNode;
  varying float vFreqAmp;
  varying float vPhase;
  varying float vWisp;
  const float VIS_INPUT_GAIN = 0.50118723; // -6 dB visual attenuation

  void main() {
    int idx = int(clamp(floor(aNode * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(aTrajectory * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp = (max(amp - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;
    float gAmp2 = (max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Scatter: particles drift outward from their origin points
    float outward = sin(uTime * 0.008 + aPhase * 2.0) * uScatter * 0.4;
    float outwardY = cos(uTime * 0.006 + aNode * 3.0) * uScatter * 0.25;

    // Breeze: lateral drift — wind carrying wisps sideways
    float wind = sin(uTime * 0.01 + aTrajectory * 5.0 + aNode * 2.0) * uBreeze * 0.35;
    float windZ = cos(uTime * 0.007 + aPhase * 1.5 + aTrajectory * 2.0) * uBreeze * 0.2;

    // Lift: upward pull — light rising
    float rise = (0.25 + gAmp * 0.75) * uLift * 0.25 + sin(uTime * 0.005 + aPhase) * uLift * 0.14;

    // Ephemeral: fading presence — particles dissolve position
    float fade = sin(uTime * 0.004 + aNode * 6.0) * uEphemeral * 0.18 * (0.25 + gAmp2 * 0.75);

    // Always-on slow wander
    float wanderX = sin(uTime * 0.019 + aPhase * 3.6 + aNode * 5.2) * 0.11;
    float wanderY = cos(uTime * 0.014 + aNode * 4.0 + aPhase * 2.2) * 0.09;
    float wanderZ = sin(uTime * 0.011 + aTrajectory * 2.4 + aNode * 3.3) * 0.06;

    vec3 newPos = position;
    newPos.x += outward + wind + fade + wanderX;
    newPos.y += outwardY + rise + wanderY;
    newPos.z += windZ + wanderZ;

    vNode = aNode;
    vFreqAmp = gAmp;
    vPhase = aPhase;
    vWisp = gAmp * uBreeze * 0.4 + rise * 0.3 + gAmp2 * 0.15;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);
    // Very large — wisps are big soft glows
    gl_PointSize = aSize * (4.5 * uEnvelope + gAmp * 5.0 + uEphemeral * 2.5 * uEnvelope + gAmp2 * 1.5) * (300.0 / -mvPos.z);

    vec4 clipPos = projectionMatrix * mvPos;
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 pointRadiusNDC = vec2(gl_PointSize) / uViewport;
    vec2 maxNDC = max(vec2(1.0) - pointRadiusNDC, vec2(0.0));
    if (uBoundary > 0.5) {
    vec2 clamped = clamp(ndc, -maxNDC, maxNDC);
    vec2 overflow = ndc - clamped;
    ndc = clamped - overflow * 0.3;
    }
    clipPos.xy = ndc * clipPos.w;
    gl_Position = clipPos;
  }
`;

const fragmentShader = `
  varying float vNode;
  varying float vFreqAmp;
  varying float vPhase;
  varying float vWisp;
  uniform float uHiss;
  uniform float uEnvelope;
  uniform float uTime;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Maximum softness — airy gaussian falloff
    float alpha = exp(-dist * dist * 6.0);
    alpha *= alpha; // extra dissolution

    // Slow colour phase — pale sage through white wisp to soft gold
    float phase = uTime * 0.005 + vNode * 2.0 + vPhase * 0.2;
    vec3 deep = vec3(0.1, 0.12, 0.08);
    vec3 sage = vec3(0.45, 0.55, 0.4);
    vec3 wisp = vec3(0.82, 0.85, 0.8);
    vec3 gold = vec3(0.92, 0.85, 0.55);

    float grad = sin(phase) * 0.5 + 0.5;
    vec3 color = mix(deep, sage, 0.3 + grad * 0.4);
    color = mix(color, wisp, vWisp * 0.45 + vFreqAmp * 0.2);
    color = mix(color, gold, vFreqAmp * vFreqAmp * 0.35 + grad * 0.1);

    // Airy grain — barely there
    float grain = hash(gl_FragCoord.xy + uTime * 2.0) * uHiss * 0.08;
    color += grain;

    alpha *= 0.12 * uEnvelope + vFreqAmp * 0.3 + vWisp * 0.1;
    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 6.0);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform }, uTime: { value: 0 },
  uScatter: { value: 0.5 }, uBreeze: { value: 0.5 }, uLift: { value: 0.5 }, uEphemeral: { value: 0.5 },
  uHiss: { value: 0.5 }, uThreshold: { value: 0.5 },
  uViewport: { value: new THREE.Vector2(innerWidth, innerHeight) },
  uBoundary:  { value: 1.0 },
  uEnvelope:  { value: 0.0 }
};

const sliders = {}, valDisplays = {};
for (let i = 1; i <= 8; i++) { const k = 'p' + i; sliders[k] = document.getElementById(k); valDisplays[k] = document.getElementById(k + '-val'); }
function randomizeSliders() { Object.keys(sliders).forEach(k => { const s = sliders[k]; const v = Math.floor(+s.min + Math.random() * (+s.max - +s.min)); s.value = v; valDisplays[k].textContent = v; }); }
Object.keys(sliders).forEach(k => { sliders[k].addEventListener('input', () => { valDisplays[k].textContent = sliders[k].value; }); });
randomizeSliders();
const randomizeBtn = document.getElementById('randomize-btn');
if (randomizeBtn) randomizeBtn.addEventListener('click', randomizeSliders);

function computeSeedValues() {
  const scatter = sliders.p1.value / 100, breeze = sliders.p2.value / 100, lift = sliders.p3.value / 100, ephemeral = sliders.p4.value / 100;
  return {
    scatter: 0.1 + scatter * 0.9, breeze: 0.1 + breeze * 0.9, lift: lift, ephemeral: 0.1 + ephemeral * 0.9,
    rotSpeedY: 0.002 + breeze * 0.022, rotSpeedX: 0.001 + breeze * 0.011, smoothing: 0.97 - scatter * 0.22, detail: Math.floor(5 + scatter * 14),
    hiss: sliders.p5.value / 100, epoch: sliders.p6.value / 100, threshold: sliders.p7.value / 100, flux: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); }

  const numOrigins = Math.floor(6 + detail * 0.7);
  const positions = [], nodeAttrs = [], phaseAttrs = [], sizeAttrs = [], trajectoryAttrs = [];

  const origins = [];
  for (let o = 0; o < numOrigins; o++) {
    origins.push({
      x: (Math.random() - 0.5) * 4.0,
      y: (Math.random() - 0.5) * 3.5,
      z: (Math.random() - 0.5) * 2.5
    });
  }

  for (let o = 0; o < numOrigins; o++) {
    const origin = origins[o];
    const ptsPerOrigin = Math.floor(8 + detail * 0.6);
    const originNorm = o / (numOrigins - 1);

    for (let p = 0; p < ptsPerOrigin; p++) {
      // Scatter in random direction from origin — further is more spread
      const r = 0.3 + Math.random() * 1.2;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const x = origin.x + r * Math.sin(phi) * Math.cos(theta);
      const y = origin.y + r * Math.sin(phi) * Math.sin(theta) * 0.8 + r * 0.15; // slight upward bias
      const z = origin.z + r * Math.cos(phi) * 0.6;
      positions.push(x, y, z);
      nodeAttrs.push(originNorm);
      phaseAttrs.push(Math.random() * Math.PI * 2);
      sizeAttrs.push(0.5 + Math.random() * 1.0);
      trajectoryAttrs.push(Math.random());
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aNode', new THREE.Float32BufferAttribute(nodeAttrs, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phaseAttrs, 1));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizeAttrs, 1));
  geo.setAttribute('aTrajectory', new THREE.Float32BufferAttribute(trajectoryAttrs, 1));
  particles = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(particles);
}
buildParticles(8);

let rotSpeedY = 0.003, rotSpeedX = 0.002, bakedEpoch = 0.5, bakedFlux = 0.5;
let seedCenter = { scatter: 0.5, breeze: 0.5, lift: 0.5, ephemeral: 0.5 };
let audioContext, analyser, dataArray, source, audioDuration = 0, audioStartTime = 0;
const _smoothedFreq = new Float32Array(64);
let _sceneSm = 0.85;
const _bassSm = 0.20;
function initAudio(sm) { audioContext = new (window.AudioContext || window.webkitAudioContext)(); analyser = audioContext.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0; _sceneSm = sm; dataArray = new Uint8Array(analyser.frequencyBinCount); }

let currentBuffer = null, currentFileName = '';
let playState = 'idle';
let _vjActive = false;
let _lastGeoKey = '';
const fileInput = document.getElementById('file-input');
const playBtn = document.getElementById('play-btn');
const controlsEl = document.getElementById('controls');

function showAudioReady() { document.getElementById('upload-area').style.display = 'none'; document.getElementById('audio-ready').style.display = 'block'; document.getElementById('audio-name').textContent = currentFileName; playBtn.textContent = '\u25b6\uFE0E Play'; playState = 'idle'; }

fileInput.addEventListener('change', e => { const file = e.target.files[0]; if (!file) return; currentFileName = file.name; if (!audioContext) initAudio(0.97); const reader = new FileReader(); reader.onload = evt => { const raw = evt.target.result; audioContext.decodeAudioData(raw.slice(0), buf => { currentBuffer = buf; audioDuration = buf.duration; showAudioReady(); AudioStore.save(raw, currentFileName); }); }; reader.readAsArrayBuffer(file); });
AudioStore.load().then(data => { if (!data) return; currentFileName = data.name; if (!audioContext) initAudio(0.97); audioContext.decodeAudioData(data.buffer, buf => { currentBuffer = buf; audioDuration = buf.duration; showAudioReady(); }); }).catch(() => {});

function ensureAudio() {
  if (!audioContext) initAudio(0.85);
  return { audioContext, analyser, dataArray };
}

function applyAndLaunch() {
  _initDriftPhases();
  if (playState === 'listening' && window.SCENE && window.SCENE._stopMic) window.SCENE._stopMic();
  const s = computeSeedValues();
  controlsEl.classList.add('hidden'); controlsEl.classList.remove('visible');
  uniforms.uScatter.value = s.scatter; uniforms.uBreeze.value = s.breeze;
  uniforms.uLift.value = s.lift; uniforms.uEphemeral.value = s.ephemeral;
  uniforms.uHiss.value = s.hiss; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { scatter: s.scatter, breeze: s.breeze, lift: s.lift, ephemeral: s.ephemeral };
  bakedEpoch = s.epoch; bakedFlux = s.flux;
  buildParticles(s.detail); _sceneSm = s.smoothing;
  _lastGeoKey = String(s.detail);
}

playBtn.addEventListener('click', () => {
  if (!currentBuffer) return;
  applyAndLaunch();

  if (playState === 'paused') { audioContext.resume(); playState = 'playing'; return; }
  if (source) { source.onended = null; try { source.stop(); } catch (e) {} source.disconnect(); }
  source = audioContext.createBufferSource(); source.buffer = currentBuffer; source.connect(analyser); analyser.connect(audioContext.destination);
  if (audioContext.state === 'suspended') audioContext.resume();
  source.start(0); audioStartTime = audioContext.currentTime; playState = 'playing';
  source.onended = () => { playState = 'idle'; playBtn.textContent = '\u25b6\uFE0E Play'; controlsEl.classList.remove('hidden'); };
});

document.getElementById('replace-btn').addEventListener('click', () => { fileInput.click(); });
renderer.domElement.addEventListener('click', () => { if (playState === 'playing') { audioContext.suspend(); playState = 'paused'; playBtn.textContent = '\u25b6\uFE0E Resume'; controlsEl.classList.add('visible'); controlsEl.classList.remove('hidden'); } });
window.addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); uniforms.uViewport.value.set(innerWidth, innerHeight); });

function storyArc(p) {
  p = Math.max(0, Math.min(1, p));
  const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return {
    scatter:   Math.max(0.05, 0.25 + 0.2 * sm(0, 0.15, p) + 0.45 * sm(0.15, 0.5, p) - 0.15 * sm(0.65, 0.85, p) - 0.35 * sm(0.88, 1, p)),
    breeze:    Math.max(0.05, 0.15 + 0.3 * sm(0.05, 0.2, p) + 0.5 * sm(0.2, 0.45, p) - 0.2 * sm(0.6, 0.8, p) - 0.35 * sm(0.85, 1, p)),
    lift:      Math.max(0.05, 0.2 + 0.15 * sm(0.1, 0.25, p) + 0.5 * sm(0.25, 0.55, p) - 0.15 * sm(0.65, 0.8, p) - 0.3 * sm(0.85, 1, p)),
    ephemeral: Math.max(0.05, 0.2 + 0.2 * sm(0.1, 0.25, p) + 0.45 * sm(0.25, 0.5, p) - 0.15 * sm(0.6, 0.78, p) - 0.35 * sm(0.82, 1, p)),
    rot: Math.max(0.1, 0.3 + 0.15 * sm(0.1, 0.3, p) + 0.4 * sm(0.3, 0.6, p) - 0.15 * sm(0.7, 0.85, p) - 0.3 * sm(0.88, 1, p))
  };
}

const clock = new THREE.Clock(), DRIFT_BASE = 108;
const driftCycles = { scatter: { period: DRIFT_BASE, depth: 0.3 }, breeze: { period: DRIFT_BASE * 0.786, depth: 0.35 }, lift: { period: DRIFT_BASE * 1.272, depth: 0.2 }, ephemeral: { period: DRIFT_BASE * 0.618, depth: 0.3 } };
const uMap = { scatter: 'uScatter', breeze: 'uBreeze', lift: 'uLift', ephemeral: 'uEphemeral' };
let _envelope = 0;
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime(); uniforms.uTime.value = elapsed;
  let arc = { scatter: 1, breeze: 1, lift: 1, ephemeral: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) { const pr = Math.min((audioContext.currentTime - audioStartTime) / audioDuration, 1); const raw = storyArc(pr); for (const k in raw) arc[k] = 1 + (raw[k] - 1) * bakedEpoch; }
  const TP = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const k in driftCycles) { const { period, depth } = driftCycles[k]; const sd = depth * (0.3 + bakedFlux * 1.4); const d = (Math.sin(dt * TP / period + (_dp[k] || 0)) * 0.65 + Math.sin(dt * TP / (period * 2.17) + 1.3 + (_dp[k] || 0)) * 0.35) * sd; uniforms[uMap[k]].value = Math.max(0.01, seedCenter[k] * (arc[k] || 1) * (1 + d)); }
  if (analyser && dataArray) { analyser.getByteFrequencyData(dataArray); for (let i = 0; i < 64; i++) { const a = i < 2 ? _bassSm : _sceneSm; _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i]; frequencyUniform[i] = _smoothedFreq[i]; } }
  { let _lvl = 0; for (let i = 0; i < 64; i++) _lvl += frequencyUniform[i]; _lvl /= (64 * 255); const _tgt = Math.min(_lvl * 3.0, 1.0); _envelope += (_tgt - _envelope) * (_tgt > _envelope ? 0.14 : 0.035); uniforms.uEnvelope.value = Math.max(_envelope, 0.02); }
  const driftAmt = 0.16 * (0.4 + bakedFlux * 0.8);
  particles.position.x = Math.sin(dt * TP / (DRIFT_BASE * 2.0) + (_dp._px || 0)) * driftAmt;
  particles.position.y = Math.sin(dt * TP / (DRIFT_BASE * 1.7) + 1.7 + (_dp._py || 0)) * driftAmt * 0.7;
  particles.position.z = Math.sin(dt * TP / (DRIFT_BASE * 2.5) + 0.9 + (_dp._pz || 0)) * driftAmt * 0.4;
  const breathe = 1.0 + Math.sin(dt * TP / (DRIFT_BASE * 2.8) + (_dp._br || 0)) * 0.09 * (arc.rot || 1);
  particles.scale.setScalar(breathe);
  particles.rotation.y = elapsed * rotSpeedY * (arc.rot || 1) * 0.35;
  particles.rotation.x = elapsed * rotSpeedX * 0.12 * (arc.rot || 1) * 0.35;
  renderer.render(scene, camera);
}

function _vjApply() {
  const s = computeSeedValues();
  uniforms.uScatter.value = s.scatter; uniforms.uBreeze.value = s.breeze;
  uniforms.uLift.value = s.lift; uniforms.uEphemeral.value = s.ephemeral;
  uniforms.uHiss.value = s.hiss; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { scatter: s.scatter, breeze: s.breeze, lift: s.lift, ephemeral: s.ephemeral };
  bakedEpoch = s.epoch; bakedFlux = s.flux;
  const gk = String(s.detail);
  if (gk !== _lastGeoKey) { buildParticles(s.detail); _lastGeoKey = gk; }
  _sceneSm = s.smoothing;
}

window.SCENE = {
  scene, camera, renderer, uniforms, frequencyUniform, _bassSm, get _sceneSm() { return _sceneSm; },
  get particles() { return particles; }, get seedCenter() { return seedCenter; },
  get rotSpeedY() { return rotSpeedY; }, get rotSpeedX() { return rotSpeedX; },
  get bakedArcScale() { return bakedEpoch; }, get bakedDriftScale() { return bakedFlux; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; }, uniformMap: uMap,
  rotXMult: 0.042, rotDriftScale: 0, tiltDriftScale: 0,
  rotYMult: 0.35, posDrift: { amt: 0.16, px: 2.0, py: 1.7, ys: 0.7, pz: 2.5, zs: 0.4 }, breathe: { period: 2.8, amp: 0.09 },
  storyArc,
  get currentBuffer() { return currentBuffer; }, get audioDuration() { return audioDuration; },
  get audioContext() { return audioContext; }, get analyser() { return analyser; },
  get playState() { return playState; },
  ensureAudio,
  applyAndLaunch,
  setPlayState(v) { playState = v; },
  stopFileAudio() { if (source) { source.onended = null; try { source.stop(); } catch(e) {} source.disconnect(); source = null; } },
  vjApply() { _vjApply(); },
  set vjActive(v) { _vjActive = v; },
  get vjActive() { return _vjActive; },
  get currentFileName() { return currentFileName; },
  sceneName: 'blown-a-wish'
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
