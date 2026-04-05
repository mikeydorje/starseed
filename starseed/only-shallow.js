const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uTremolo;
  uniform float uFeedback;
  uniform float uSaturation;
  uniform float uTapeHead;
  uniform float uThreshold;
  uniform vec2 uViewport;
  uniform float uBoundary;
  uniform float uEnvelope;
  attribute float aNode;
  attribute float aPhase;
  attribute float aSize;
  varying float vNode;
  varying float vFreqAmp;
  varying float vPhase;
  varying float vHeat;
  const float VIS_INPUT_GAIN = 0.50118723; // -6 dB visual attenuation

  void main() {
    int idx = int(clamp(floor(aNode * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(aPhase / 6.283 * 63.0), 0.0, 63.0));
    float amp = uFrequencyData[idx] / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp = (max(amp - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;
    float gAmp2 = (max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Tremolo: slow field-wide amplitude throb
    float trem = sin(uTime * (0.08 + uTremolo * 0.15) + aNode * 4.0 + aPhase) * 0.5 + 0.5;

    // Feedback: positions fold back on themselves — neighboring nodes pull
    float fbX = sin(position.y * 2.0 + uTime * 0.03 + aPhase) * uFeedback * 0.45 * (0.25 + gAmp * 0.75);
    float fbY = cos(position.x * 1.8 + uTime * 0.025 - aNode * 3.0) * uFeedback * 0.38 * (0.25 + gAmp2 * 0.75);
    float fbZ = sin(position.z * 1.5 + uTime * 0.02 + aPhase * 0.7) * uFeedback * 0.28 * (0.25 + gAmp * 0.75);

    // Saturation: soft-clip displacement — compresses peaks, widens field
    float rawDisp = (gAmp * 0.5 + gAmp2 * 0.5) * 0.4;
    float sat = uSaturation * 2.0 + 0.5;
    float saturated = rawDisp / (1.0 + abs(rawDisp) * sat);

    // Tape head: wow drift — entire field slowly warps
    float wow = sin(uTime * 0.02 + aNode * 2.3) * uTapeHead * 0.28;
    float flutter = sin(uTime * 0.4 + aPhase * 5.0) * uTapeHead * 0.06 * gAmp;

    // Always-on slow wander
    float wanderX = sin(uTime * 0.018 + aPhase * 3.5 + aNode * 5.0) * 0.12;
    float wanderY = cos(uTime * 0.013 + aNode * 4.2 + aPhase * 2.3) * 0.09;
    float wanderZ = sin(uTime * 0.010 + aPhase * 1.7 + aNode * 3.1) * 0.06;

    vec3 newPos = position;
    newPos.x += fbX + wow * 0.3 + flutter + wanderX;
    newPos.y += fbY + saturated * 0.3 + sin(uTime * 0.015 + aNode * 1.7) * 0.04 + wanderY;
    newPos.z += fbZ + wow * 0.2 + wanderZ;

    vNode = aNode;
    vFreqAmp = gAmp;
    vPhase = aPhase;
    vHeat = saturated + trem * gAmp * uTremolo * 0.5;

    vec4 mvPos = modelViewMatrix * vec4(newPos, 1.0);
    // Large soft points — reads as gradient fields, not particles
    gl_PointSize = aSize * (3.5 * uEnvelope + gAmp * 5.0 + uSaturation * 2.0 * uEnvelope + trem * 1.5 * uEnvelope) * (300.0 / -mvPos.z);

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
  varying float vHeat;
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
    // Very soft — entire circle is a gradient, no hard core
    float alpha = (1.0 - smoothstep(0.0, 0.5, dist));
    alpha *= alpha; // extra soft falloff

    // Slow colour phase — shifts through crimson field over time
    float phase = uTime * 0.008 + vNode * 2.0 + vPhase * 0.3;
    vec3 deep = vec3(0.35, 0.04, 0.06);
    vec3 crimson = vec3(0.8, 0.12, 0.1);
    vec3 hot = vec3(1.0, 0.7, 0.4);
    vec3 white = vec3(1.0, 0.95, 0.9);

    float grad = sin(phase) * 0.5 + 0.5;
    vec3 color = mix(deep, crimson, grad * 0.6 + vFreqAmp * 0.4);
    color = mix(color, hot, vHeat * 0.5);
    color = mix(color, white, vFreqAmp * vFreqAmp * 0.35);

    // Film grain
    float grain = hash(gl_FragCoord.xy + uTime * 4.0) * uHiss * 0.12;
    color += grain;

    alpha *= 0.2 * uEnvelope + vFreqAmp * 0.4 + vHeat * 0.15;
    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 5.5);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData: { value: frequencyUniform }, uTime: { value: 0 },
  uTremolo: { value: 0.5 }, uFeedback: { value: 0.5 }, uSaturation: { value: 0.5 }, uTapeHead: { value: 0.5 },
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
  const tremolo = sliders.p1.value / 100, feedback = sliders.p2.value / 100, saturation = sliders.p3.value / 100, tapeHead = sliders.p4.value / 100;
  return {
    tremolo: 0.1 + tremolo * 0.9, feedback: 0.1 + feedback * 0.9 * (1 + tremolo * 0.15), saturation: saturation, tapeHead: 0.1 + tapeHead * 0.9,
    rotSpeedY: 0.003 + feedback * 0.035, rotSpeedX: 0.002 + feedback * 0.018, smoothing: 0.96 - tremolo * 0.15, detail: Math.floor(8 + tremolo * 24),
    hiss: sliders.p5.value / 100, epoch: sliders.p6.value / 100, threshold: sliders.p7.value / 100, flux: sliders.p8.value / 100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); }

  const count = Math.floor(80 + detail * 4);
  const positions = [], nodeAttrs = [], phaseAttrs = [], sizeAttrs = [];

  for (let i = 0; i < count; i++) {
    const n = i / (count - 1);
    // Random positions in a volume — no central bias
    const x = (Math.random() - 0.5) * 5.5;
    const y = (Math.random() - 0.5) * 4.0;
    const z = (Math.random() - 0.5) * 3.0;
    positions.push(x, y, z);
    nodeAttrs.push(n);
    phaseAttrs.push(Math.random() * Math.PI * 2);
    // Varied sizes — some large blobs, some smaller accents
    sizeAttrs.push(0.5 + Math.random() * 1.0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aNode', new THREE.Float32BufferAttribute(nodeAttrs, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phaseAttrs, 1));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizeAttrs, 1));
  particles = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(particles);
}
buildParticles(18);

let rotSpeedY = 0.006, rotSpeedX = 0.003, bakedEpoch = 0.5, bakedFlux = 0.5;
let seedCenter = { tremolo: 0.5, feedback: 0.5, saturation: 0.5, tapeHead: 0.5 };
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

fileInput.addEventListener('change', e => { const file = e.target.files[0]; if (!file) return; currentFileName = file.name; if (!audioContext) initAudio(0.96); const reader = new FileReader(); reader.onload = evt => { const raw = evt.target.result; audioContext.decodeAudioData(raw.slice(0), buf => { currentBuffer = buf; audioDuration = buf.duration; showAudioReady(); AudioStore.save(raw, currentFileName); }); }; reader.readAsArrayBuffer(file); });
AudioStore.load().then(data => { if (!data) return; currentFileName = data.name; if (!audioContext) initAudio(0.96); audioContext.decodeAudioData(data.buffer, buf => { currentBuffer = buf; audioDuration = buf.duration; showAudioReady(); }); }).catch(() => {});

function ensureAudio() {
  if (!audioContext) initAudio(0.85);
  return { audioContext, analyser, dataArray };
}

function applyAndLaunch() {
  _initDriftPhases();
  if (playState === 'listening' && window.SCENE && window.SCENE._stopMic) window.SCENE._stopMic();
  const s = computeSeedValues();
  controlsEl.classList.add('hidden'); controlsEl.classList.remove('visible');
  uniforms.uTremolo.value = s.tremolo; uniforms.uFeedback.value = s.feedback;
  uniforms.uSaturation.value = s.saturation; uniforms.uTapeHead.value = s.tapeHead;
  uniforms.uHiss.value = s.hiss; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { tremolo: s.tremolo, feedback: s.feedback, saturation: s.saturation, tapeHead: s.tapeHead };
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
    tremolo:    Math.max(0.05, 0.2 + 0.2 * sm(0, 0.15, p) + 0.5 * sm(0.15, 0.45, p) - 0.2 * sm(0.65, 0.85, p) - 0.4 * sm(0.85, 1, p)),
    feedback:   Math.max(0.05, 0.15 + 0.25 * sm(0.05, 0.2, p) + 0.55 * sm(0.2, 0.5, p) - 0.15 * sm(0.6, 0.8, p) - 0.4 * sm(0.85, 1, p)),
    saturation: Math.max(0.05, 0.3 + 0.15 * sm(0.1, 0.3, p) + 0.45 * sm(0.3, 0.55, p) - 0.2 * sm(0.7, 0.85, p) - 0.3 * sm(0.88, 1, p)),
    tapeHead:   Math.max(0.05, 0.2 + 0.2 * sm(0.1, 0.25, p) + 0.5 * sm(0.25, 0.5, p) - 0.15 * sm(0.6, 0.78, p) - 0.35 * sm(0.82, 1, p)),
    rot: Math.max(0.1, 0.3 + 0.15 * sm(0.1, 0.3, p) + 0.4 * sm(0.3, 0.6, p) - 0.15 * sm(0.7, 0.85, p) - 0.3 * sm(0.88, 1, p))
  };
}

const clock = new THREE.Clock(), DRIFT_BASE = 108;
const driftCycles = { tremolo: { period: DRIFT_BASE, depth: 0.3 }, feedback: { period: DRIFT_BASE * 0.786, depth: 0.3 }, saturation: { period: DRIFT_BASE * 1.272, depth: 0.25 }, tapeHead: { period: DRIFT_BASE * 0.618, depth: 0.3 } };
const uMap = { tremolo: 'uTremolo', feedback: 'uFeedback', saturation: 'uSaturation', tapeHead: 'uTapeHead' };
let _envelope = 0;
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime(); uniforms.uTime.value = elapsed;
  let arc = { tremolo: 1, feedback: 1, saturation: 1, tapeHead: 1, rot: 1 };
  if (playState === 'playing' && audioDuration > 0 && audioStartTime > 0) { const pr = Math.min((audioContext.currentTime - audioStartTime) / audioDuration, 1); const raw = storyArc(pr); for (const k in raw) arc[k] = 1 + (raw[k] - 1) * bakedEpoch; }
  const TP = Math.PI * 2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for (const k in driftCycles) { const { period, depth } = driftCycles[k]; const sd = depth * (0.3 + bakedFlux * 1.4); const d = (Math.sin(dt * TP / period + (_dp[k] || 0)) * 0.65 + Math.sin(dt * TP / (period * 2.17) + 1.3 + (_dp[k] || 0)) * 0.35) * sd; uniforms[uMap[k]].value = Math.max(0.01, seedCenter[k] * (arc[k] || 1) * (1 + d)); }
  if (analyser && dataArray) { analyser.getByteFrequencyData(dataArray); for (let i = 0; i < 64; i++) { const a = i < 2 ? _bassSm : _sceneSm; _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i]; frequencyUniform[i] = _smoothedFreq[i]; } }
  { let _lvl = 0; for (let i = 0; i < 64; i++) _lvl += frequencyUniform[i]; _lvl /= (64 * 255); const _tgt = Math.min(_lvl * 3.0, 1.0); _envelope += (_tgt - _envelope) * (_tgt > _envelope ? 0.14 : 0.035); uniforms.uEnvelope.value = Math.max(_envelope, 0.02); }
  const driftAmt = 0.18 * (0.4 + bakedFlux * 0.8);
  particles.position.x = Math.sin(dt * TP / (DRIFT_BASE * 2.0) + (_dp._px || 0)) * driftAmt;
  particles.position.y = Math.sin(dt * TP / (DRIFT_BASE * 1.6) + 1.7 + (_dp._py || 0)) * driftAmt * 0.7;
  particles.position.z = Math.sin(dt * TP / (DRIFT_BASE * 2.8) + 0.9 + (_dp._pz || 0)) * driftAmt * 0.4;
  const breathe = 1.0 + Math.sin(dt * TP / (DRIFT_BASE * 2.5) + (_dp._br || 0)) * 0.09 * (arc.rot || 1);
  particles.scale.setScalar(breathe);
  particles.rotation.y = elapsed * rotSpeedY * (arc.rot || 1) * 0.35;
  particles.rotation.x = elapsed * rotSpeedX * 0.2 * (arc.rot || 1) * 0.35;
  renderer.render(scene, camera);
}

function _vjApply() {
  const s = computeSeedValues();
  uniforms.uTremolo.value = s.tremolo; uniforms.uFeedback.value = s.feedback;
  uniforms.uSaturation.value = s.saturation; uniforms.uTapeHead.value = s.tapeHead;
  uniforms.uHiss.value = s.hiss; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { tremolo: s.tremolo, feedback: s.feedback, saturation: s.saturation, tapeHead: s.tapeHead };
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
  rotXMult: 0.07, rotDriftScale: 0, tiltDriftScale: 0,
  rotYMult: 0.35, posDrift: { amt: 0.18, px: 2.0, py: 1.6, ys: 0.7, pz: 2.8, zs: 0.4 }, breathe: { period: 2.5, amp: 0.09 },
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
  sceneName: 'only-shallow'
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
