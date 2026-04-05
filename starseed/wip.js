const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uDissolve;
  uniform float uReverbField;
  uniform float uSoftFocus;
  uniform float uDetuning;
  uniform float uBandShift;
  uniform float uGravityShift;
  uniform float uThreshold;
  uniform float uEnvelope;
  uniform vec2 uViewport;
  attribute float aBand;
  attribute float aAlong;
  attribute float aPhase;
  attribute float aSize;
  varying float vBand;
  varying float vFreqAmp;
  varying float vPhase;
  varying float vHaze;
  const float VIS_INPUT_GAIN = 0.50118723; // -6 dB visual attenuation

  void main() {
    // Circular frequency-bin remap — migrates the energy hotspot vertically
    float shiftedBand  = fract(aBand + uGravityShift);
    float shiftedAlong = fract(aAlong + uGravityShift * 0.73);
    int idx  = int(clamp(floor(shiftedBand  * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(shiftedAlong * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp = (max(amp - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;
    float gAmp2 = (max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Dissolve: particles scatter from their band — structure melting
    float scatter = sin(aPhase * 7.0 + uTime * 0.02 + aBand * 5.0) * uDissolve * 0.3 * gAmp;
    float scatterY = cos(aPhase * 3.0 + uTime * 0.015) * uDissolve * 0.15 * gAmp2;

    // Reverb field: echo trails — position smears based on recent energy
    float trail = sin(uTime * 0.01 + aAlong * 4.0 + aBand * 2.0) * uReverbField * 0.2;
    float trailZ = cos(uTime * 0.008 + aPhase * 2.0) * uReverbField * 0.15 * gAmp;

    // Detuning: two copies slightly apart — slow pitch drift
    float detune = sin(uTime * 0.006 + aBand * 3.0) * uDetuning * 0.15;

    // Bottom-band drift: weight follows shifted energy center
    float bottomWeight = (1.0 - shiftedBand);
    float bandDrift = bottomWeight * bottomWeight * uBandShift;

    vec3 newPos = position;
    newPos.x += scatter + trail + detune + bandDrift * 0.4 * sin(uTime * 0.009 + aPhase);
    newPos.y += scatterY + sin(uTime * 0.01 + aAlong * 2.0) * 0.05 + bandDrift;
    newPos.z += trailZ + bandDrift * 0.25 * cos(uTime * 0.007 + aBand * 3.0);

    vBand = aBand;
    vFreqAmp = gAmp;
    vPhase = aPhase;
    vHaze = gAmp * uReverbField * 0.5 + scatter * 0.3;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);
    // Very large soft points — overlapping creates haze layers
    gl_PointSize = aSize * (4.0 * uEnvelope + gAmp * 6.0 + uSoftFocus * 3.0 * uEnvelope) * (300.0 / -mvPos.z);

    vec4 clipPos = projectionMatrix * mvPos;
    vec2 ndc = clipPos.xy / clipPos.w;
    vec2 pointRadiusNDC = vec2(gl_PointSize) / uViewport;
    vec2 maxNDC = max(vec2(1.0) - pointRadiusNDC, vec2(0.0));
    vec2 clamped = clamp(ndc, -maxNDC, maxNDC);
    vec2 overflow = ndc - clamped;
    ndc = clamped - overflow * 0.3;
    clipPos.xy = ndc * clipPos.w;
    gl_Position = clipPos;
  }
`;

const fragmentShader = `
  varying float vBand;
  varying float vFreqAmp;
  varying float vPhase;
  varying float vHaze;
  uniform float uHaze;
  uniform float uEnvelope;
  uniform float uTime;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    // Ultra-soft gaussian-like profile
    float alpha = exp(-dist * dist * 8.0);

    // Slow colour phase — lavender through silver
    float phase = uTime * 0.006 + vBand * 3.0 + vPhase * 0.2;
    vec3 deep = vec3(0.15, 0.1, 0.25);
    vec3 lavender = vec3(0.55, 0.4, 0.65);
    vec3 silver = vec3(0.75, 0.72, 0.82);
    vec3 white = vec3(0.92, 0.9, 0.97);

    float grad = sin(phase) * 0.5 + 0.5;
    vec3 color = mix(deep, lavender, grad * 0.5 + vFreqAmp * 0.3);
    color = mix(color, silver, vHaze * 0.4 + vFreqAmp * 0.3);
    color = mix(color, white, vFreqAmp * vFreqAmp * 0.3);

    // Haze grain
    float grain = hash(gl_FragCoord.xy + uTime * 3.0) * uHaze * 0.06;
    color += grain;

    alpha *= 0.15 * uEnvelope + vFreqAmp * 0.35 + vHaze * 0.1;
    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(41, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 6.9);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform }, uTime: { value: 0 },
  uDissolve: { value: 0.5 }, uReverbField: { value: 0.5 }, uSoftFocus: { value: 0.5 }, uDetuning: { value: 0.5 },
  uHaze: { value: 0.5 }, uBandShift: { value: 0 }, uGravityShift: { value: 0 }, uThreshold: { value: 0.5 },
  uViewport: { value: new THREE.Vector2(innerWidth, innerHeight) },
  uEnvelope: { value: 0.0 }
};

const sliders = {}, valDisplays = {};
for (let i = 1; i <= 8; i++) { const k = 'p' + i; sliders[k] = document.getElementById(k); valDisplays[k] = document.getElementById(k + '-val'); }
function randomizeSliders() { Object.keys(sliders).forEach(k => { const s = sliders[k]; const v = Math.floor(+s.min + Math.random() * (+s.max - +s.min)); s.value = v; valDisplays[k].textContent = v; }); }
Object.keys(sliders).forEach(k => { sliders[k].addEventListener('input', () => { valDisplays[k].textContent = sliders[k].value; }); });
randomizeSliders();
const randomizeBtn = document.getElementById('randomize-btn');
if (randomizeBtn) randomizeBtn.addEventListener('click', randomizeSliders);

function computeSeedValues() {
  const dissolve = sliders.p1.value / 100, reverbField = sliders.p2.value / 100, softFocus = sliders.p3.value / 100, detuning = sliders.p4.value / 100;
  return {
    dissolve: 0.1 + dissolve * 0.9, reverbField: 0.1 + reverbField * 0.9, softFocus: softFocus, detuning: 0.1 + detuning * 0.9,
    rotSpeedY: 0.002 + reverbField * 0.008, rotSpeedX: 0.001 + reverbField * 0.004, smoothing: 0.97 - dissolve * 0.12, detail: Math.floor(8 + dissolve * 24),
    haze: sliders.p5.value / 100, epoch: sliders.p6.value / 100, threshold: sliders.p7.value / 100, flux: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); }

  const bands = Math.floor(8 + detail * 0.3);
  const positions = [], bandAttrs = [], alongAttrs = [], phaseAttrs = [], sizeAttrs = [];

  for (let b = 0; b < bands; b++) {
    const bandNorm = b / (bands - 1);
    // Bands distributed across Y — no center bias
    const baseY = (bandNorm - 0.5) * 4.5 + Math.sin(b * 2.39) * 0.3;
    const bandZ = Math.sin(b * 1.618) * 0.8;
    const ptsPerBand = Math.floor(10 + detail * 0.5);

    for (let p = 0; p < ptsPerBand; p++) {
      const along = p / (ptsPerBand - 1);
      const x = (along - 0.5) * 6.0 + (Math.random() - 0.5) * 0.8;
      const y = baseY + (Math.random() - 0.5) * 0.6;
      const z = bandZ + (Math.random() - 0.5) * 0.5;
      positions.push(x, y, z);
      bandAttrs.push(bandNorm);
      alongAttrs.push(along);
      phaseAttrs.push(Math.random() * Math.PI * 2);
      sizeAttrs.push(0.6 + Math.random() * 0.9);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aBand', new THREE.Float32BufferAttribute(bandAttrs, 1));
  geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(alongAttrs, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phaseAttrs, 1));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizeAttrs, 1));
  particles = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(particles);
}
buildParticles(18);

let rotSpeedY = 0.004, rotSpeedX = 0.002, bakedEpoch = 0.5, bakedFlux = 0.5;
let seedCenter = { dissolve: 0.5, reverbField: 0.5, softFocus: 0.5, detuning: 0.5 };
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
  uniforms.uDissolve.value = s.dissolve; uniforms.uReverbField.value = s.reverbField;
  uniforms.uSoftFocus.value = s.softFocus; uniforms.uDetuning.value = s.detuning;
  uniforms.uHaze.value = s.haze; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { dissolve: s.dissolve, reverbField: s.reverbField, softFocus: s.softFocus, detuning: s.detuning };
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
    dissolve:    Math.max(0.05, 0.25 + 0.2 * sm(0, 0.15, p) + 0.45 * sm(0.15, 0.5, p) - 0.15 * sm(0.65, 0.85, p) - 0.35 * sm(0.88, 1, p)),
    reverbField: Math.max(0.05, 0.15 + 0.3 * sm(0.05, 0.2, p) + 0.5 * sm(0.2, 0.45, p) - 0.2 * sm(0.6, 0.8, p) - 0.35 * sm(0.85, 1, p)),
    softFocus:   Math.max(0.05, 0.2 + 0.15 * sm(0.1, 0.25, p) + 0.5 * sm(0.25, 0.55, p) - 0.15 * sm(0.65, 0.8, p) - 0.3 * sm(0.85, 1, p)),
    detuning:    Math.max(0.05, 0.2 + 0.2 * sm(0.1, 0.25, p) + 0.5 * sm(0.25, 0.5, p) - 0.15 * sm(0.6, 0.78, p) - 0.35 * sm(0.82, 1, p)),
    rot: Math.max(0.1, 0.3 + 0.15 * sm(0.1, 0.3, p) + 0.4 * sm(0.3, 0.6, p) - 0.15 * sm(0.7, 0.85, p) - 0.3 * sm(0.88, 1, p))
  };
}

const clock = new THREE.Clock(), DRIFT_BASE = 240;
const driftCycles = { dissolve: { period: DRIFT_BASE, depth: 0.3 }, reverbField: { period: DRIFT_BASE * 0.786, depth: 0.35 }, softFocus: { period: DRIFT_BASE * 1.272, depth: 0.2 }, detuning: { period: DRIFT_BASE * 0.618, depth: 0.3 } };
const uMap = { dissolve: 'uDissolve', reverbField: 'uReverbField', softFocus: 'uSoftFocus', detuning: 'uDetuning' };
let _envelope = 0;
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime(); uniforms.uTime.value = elapsed;
  let arc = { dissolve: 1, reverbField: 1, softFocus: 1, detuning: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) { const pr = Math.min((audioContext.currentTime - audioStartTime) / audioDuration, 1); const raw = storyArc(pr); for (const k in raw) arc[k] = 1 + (raw[k] - 1) * bakedEpoch; }
  const TP = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const k in driftCycles) { const { period, depth } = driftCycles[k]; const sd = depth * (0.3 + bakedFlux * 1.4); const d = (Math.sin(dt * TP / period + (_dp[k] || 0)) * 0.65 + Math.sin(dt * TP / (period * 2.17) + 1.3 + (_dp[k] || 0)) * 0.35) * sd; uniforms[uMap[k]].value = Math.max(0.01, seedCenter[k] * (arc[k] || 1) * (1 + d)); }
  if (analyser && dataArray) { analyser.getByteFrequencyData(dataArray); for (let i = 0; i < 64; i++) { const a = i < 2 ? _bassSm : _sceneSm; _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i]; frequencyUniform[i] = _smoothedFreq[i]; } }
  { let _lvl = 0; for (let i = 0; i < 64; i++) _lvl += frequencyUniform[i]; _lvl /= (64 * 255); const _tgt = Math.min(_lvl * 3.0, 1.0); _envelope += (_tgt - _envelope) * (_tgt > _envelope ? 0.14 : 0.035); uniforms.uEnvelope.value = Math.max(_envelope, 0.02); }
  const driftAmt = 0.05 * (0.4 + bakedFlux * 0.8);
  particles.position.x = Math.sin(dt * TP / (DRIFT_BASE * 2.2) + (_dp._px || 0)) * driftAmt;
  particles.position.y = Math.sin(dt * TP / (DRIFT_BASE * 1.8) + 1.7 + (_dp._py || 0)) * driftAmt * 0.6;
  const bandShiftAmt = 1.2 * (0.3 + bakedFlux * 1.4);
  uniforms.uBandShift.value = (Math.sin(dt * TP / (DRIFT_BASE * 0.92)) * 0.6 + Math.sin(dt * TP / (DRIFT_BASE * 1.73) + 2.1) * 0.4) * bandShiftAmt;
  // Gravity shift: slowly migrate the energy hotspot vertically
  let gravBase = (Math.sin(dt * TP / (DRIFT_BASE * 1.37)) * 0.5 + Math.sin(dt * TP / (DRIFT_BASE * 0.61) + 0.9) * 0.3 + Math.sin(dt * TP / (DRIFT_BASE * 3.14) + 2.6) * 0.2);
  // Audio-reactive nudge: bass energy gently accelerates the shift
  let bassNudge = 0;
  if (analyser && dataArray) { for (let i = 0; i < 8; i++) bassNudge += frequencyUniform[i]; bassNudge = (bassNudge / (8 * 255)) * 0.12; }
  uniforms.uGravityShift.value = gravBase * (0.25 + bakedFlux * 0.35) + bassNudge;
  const breathe = 1.0 + Math.sin(dt * TP / (DRIFT_BASE * 2.8) + (_dp._br || 0)) * 0.04 * (arc.rot || 1);
  particles.scale.setScalar(breathe);
  particles.rotation.y = elapsed * rotSpeedY * (arc.rot || 1) * 0.1;
  particles.rotation.x = elapsed * rotSpeedX * 0.2 * (arc.rot || 1) * 0.1;
  renderer.render(scene, camera);
}

function _vjApply() {
  const s = computeSeedValues();
  uniforms.uDissolve.value = s.dissolve; uniforms.uReverbField.value = s.reverbField;
  uniforms.uSoftFocus.value = s.softFocus; uniforms.uDetuning.value = s.detuning;
  uniforms.uHaze.value = s.haze; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { dissolve: s.dissolve, reverbField: s.reverbField, softFocus: s.softFocus, detuning: s.detuning };
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
  rotXMult: 0.02, rotDriftScale: 0, tiltDriftScale: 0,
  rotYMult: 0.1, posDrift: { amt: 0.05, px: 2.2, py: 1.8, ys: 0.6 }, breathe: { period: 2.8, amp: 0.04 },
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
  sceneName: 'wip'
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
