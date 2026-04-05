const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uHarmony;
  uniform float uMelody;
  uniform float uPhaseShift;
  uniform float uOvertone;
  uniform float uThreshold;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aT;
  attribute float aLayer;
  attribute float aPhase;
  varying float vLayer;
  varying float vFreqAmp;
  varying float vT;
  varying float vRainbow;

  #define PI  3.14159265358979
  #define TAU 6.28318530717959

  void main() {
    int idx  = int(clamp(floor(aLayer * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(aT * 63.0), 0.0, 63.0));
    int idx3 = int(clamp(floor(aPhase / TAU * 63.0), 0.0, 63.0));
    float amp  = uFrequencyData[idx]  / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;
    float amp3 = uFrequencyData[idx3] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp  = max(amp  - gate, 0.0) / max(1.0 - gate, 0.01);
    float gAmp2 = max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01);
    float gAmp3 = max(amp3 - gate, 0.0) / max(1.0 - gate, 0.01);

    float baseR = 0.25 + aLayer * 1.4;
    float angle = aT * TAU;

    float cx = baseR * cos(angle);
    float cy = baseR * sin(angle);

    // First pendulum: frequency ratio a:b
    // Near-integer a,b = closed curves (stars, figure-8s, trefoils)
    // Audio detunes them into precessing open curves
    float a = floor(1.0 + uHarmony * 6.0) + gAmp * 0.15;
    float b = floor(1.0 + uMelody * 6.0)  + gAmp2 * 0.15;

    // Phase shift — controls the shape of the Lissajous figure
    float delta = uPhaseShift * PI + gAmp3 * 0.5;

    // Primary Lissajous warp applied as radial + tangential offset
    float lissR = sin(a * angle + delta) * 0.35;
    float lissT = sin(b * angle) * 0.35;

    // Second harmonic layer (overtone) — smaller, faster, wilder
    float a2 = a * 2.0 + 1.0;
    float b2 = b * 2.0 - 1.0;
    float overtoneAmt = uOvertone * 0.5;
    float lissR2 = sin(a2 * angle + delta * 1.618) * overtoneAmt * 0.2;
    float lissT2 = sin(b2 * angle + PI * 0.25) * overtoneAmt * 0.2;

    // Third harmonic — dreamy slow precession
    float lissR3 = sin(3.0 * angle + uTime * 0.08) * 0.06 * gAmp;
    float lissT3 = cos(5.0 * angle - uTime * 0.06) * 0.06 * gAmp2;

    // Combine all Lissajous harmonics
    float totalR = lissR + lissR2 + lissR3;
    float totalT = lissT + lissT2 + lissT3;

    // Modulation amount driven by audio
    float morphAmt = gAmp * 0.4 + gAmp2 * 0.35 + gAmp3 * 0.25;

    // Apply as radial displacement + tangential displacement
    float r = baseR + totalR * morphAmt * baseR;
    float theta = angle + totalT * morphAmt * 0.5;

    float x = mix(cx, cos(theta) * r, morphAmt);
    float y = mix(cy, sin(theta) * r, morphAmt);

    // Z-depth: layers breathe with music
    float z = (aLayer - 0.5) * 0.4 + sin(angle * 2.0 + uTime * 0.12) * gAmp * 0.08;

    // Rainbow index for fragment: based on angle, layer, and Lissajous state
    vRainbow = aT + aLayer * 0.618 + totalR * 0.5 + uTime * 0.015;
    vLayer = aLayer;
    vFreqAmp = gAmp;
    vT = aT;

    vec4 mvPos = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_PointSize = (0.9 + gAmp * 2.5) * (230.0 / -mvPos.z) * step(0.003, gAmp) + 0.7;

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
  varying float vT;
  varying float vRainbow;
  uniform float uSpectrum;
  uniform float uTime;

  #define TAU 6.28318530717959

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = 1.0 - smoothstep(0.08, 0.42, dist);
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.06;

    // Full rainbow candy palette — Adventure Time style
    // Each particle gets its own hue based on position + time
    float hue = vRainbow + uSpectrum * 2.0;
    vec3 color = 0.5 + 0.5 * cos(TAU * (hue + vec3(0.0, 0.33, 0.67)));

    // Boost saturation and brightness — candy colors
    color = pow(color, vec3(0.8));
    color = mix(color, vec3(1.0), vFreqAmp * 0.5);

    // Sparkle: occasional bright spots
    float sparkle = pow(max(sin(vT * 200.0 + uTime * 3.0), 0.0), 20.0) * vFreqAmp;
    color += sparkle * 0.4;

    alpha *= 0.55 + vFreqAmp * 0.45;
    alpha += halo;
    gl_FragColor = vec4(color, alpha);
  }
`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 4.5);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const frequencyUniform = new Float32Array(64);
const uniforms = {
  uFrequencyData:{ value: frequencyUniform }, uTime:{ value:0 },
  uHarmony:{ value:0.5 }, uMelody:{ value:0.5 }, uPhaseShift:{ value:0.5 }, uOvertone:{ value:0.5 },
  uSpectrum:{ value:0.5 }, uThreshold:{ value:0.5 },
  uViewport:{ value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uBoundary:  { value: 1.0 }
};

const sliders = {}, valDisplays = {};
for (let i = 1; i <= 8; i++) { const k='p'+i; sliders[k]=document.getElementById(k); valDisplays[k]=document.getElementById(k+'-val'); }
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
  const harmony=sliders.p1.value/100, melody=sliders.p2.value/100, phase=sliders.p3.value/100, overtone=sliders.p4.value/100;
  return {
    harmony:0.1+harmony*0.9, melody:0.1+melody*0.9*(1+harmony*0.2), phaseShift:phase, overtone:0.1+overtone*0.9,
    rotSpeedY:0.006+harmony*0.025, rotSpeedX:0.003+melody*0.012, smoothing:0.86-harmony*0.35,
    detail:Math.floor(8+harmony*28),
    spectrum:sliders.p5.value/100, epoch:sliders.p6.value/100, threshold:sliders.p7.value/100, flux:sliders.p8.value/100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); }
  const layers = Math.floor(6 + detail * 0.4);
  const pos=[], tA=[], lA=[], pA=[];
  for (let l = 0; l < layers; l++) {
    const ln = l / (layers - 1);
    const baseR = 0.25 + ln * 1.4;
    const pts = Math.floor(90 + detail * 2.5);
    for (let p = 0; p < pts; p++) {
      const t = p / pts;
      pos.push(Math.cos(t*Math.PI*2)*baseR, Math.sin(t*Math.PI*2)*baseR, (ln-0.5)*0.4);
      tA.push(t); lA.push(ln); pA.push(Math.random()*Math.PI*2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(tA,1));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(lA,1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(pA,1));
  particles = new THREE.Points(geo, new THREE.ShaderMaterial({vertexShader,fragmentShader,uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
  scene.add(particles);
}
buildParticles(18);

let rotSpeedY=0.012, rotSpeedX=0.006, bakedEpoch=0.5, bakedFlux=0.5;
let seedCenter = { harmony:0.5, melody:0.5, phaseShift:0.5, overtone:0.5 };
let audioContext,analyser,dataArray,source,audioDuration=0,audioStartTime=0;
const _smoothedFreq = new Float32Array(64);
let _sceneSm = 0.85;
const _bassSm = 0.05;
function initAudio(sm) { audioContext=new(window.AudioContext||window.webkitAudioContext)(); analyser=audioContext.createAnalyser(); analyser.fftSize=128; analyser.smoothingTimeConstant=0; _sceneSm=sm; dataArray=new Uint8Array(analyser.frequencyBinCount); }

let currentBuffer=null, currentFileName='';
let playState='idle';
let _vjActive = false;
let _lastGeoKey = '';
const fileInput=document.getElementById('file-input');
const playBtn=document.getElementById('play-btn');
const controlsEl=document.getElementById('controls');

function showAudioReady(){
  document.getElementById('upload-area').style.display='none';
  document.getElementById('audio-ready').style.display='block';
  document.getElementById('audio-name').textContent=currentFileName;
  playBtn.textContent='\u25b6\uFE0E Play';
  playState='idle';
}

fileInput.addEventListener('change', e => {
  const file=e.target.files[0]; if(!file)return;
  currentFileName=file.name;
  if(!audioContext) initAudio(0.85);
  const reader=new FileReader();
  reader.onload=evt=>{
    const raw=evt.target.result;
    audioContext.decodeAudioData(raw.slice(0),buf=>{currentBuffer=buf;audioDuration=buf.duration;showAudioReady();AudioStore.save(raw,currentFileName);});
  };
  reader.readAsArrayBuffer(file);
});

AudioStore.load().then(data=>{
  if(!data)return;
  currentFileName=data.name;
  if(!audioContext) initAudio(0.85);
  audioContext.decodeAudioData(data.buffer,buf=>{currentBuffer=buf;audioDuration=buf.duration;showAudioReady();});
}).catch(()=>{});

function ensureAudio() {
  if (!audioContext) initAudio(0.85);
  return { audioContext, analyser, dataArray };
}

function applyAndLaunch() {
  _initDriftPhases();
  if (playState === 'listening' && window.SCENE && window.SCENE._stopMic) window.SCENE._stopMic();
  const s=computeSeedValues();
  controlsEl.classList.add('hidden'); controlsEl.classList.remove('visible');
  uniforms.uHarmony.value=s.harmony; uniforms.uMelody.value=s.melody;
  uniforms.uPhaseShift.value=s.phaseShift; uniforms.uOvertone.value=s.overtone;
  uniforms.uSpectrum.value=s.spectrum; uniforms.uThreshold.value=s.threshold;
  rotSpeedY=s.rotSpeedY; rotSpeedX=s.rotSpeedX;
  seedCenter={harmony:s.harmony, melody:s.melody, phaseShift:s.phaseShift, overtone:s.overtone};
  bakedEpoch=s.epoch; bakedFlux=s.flux;
  buildParticles(s.detail);
  _lastGeoKey = String(s.detail);
  _sceneSm=s.smoothing;
}

playBtn.addEventListener('click', () => {
  if(!currentBuffer)return;
  applyAndLaunch();

  if(playState==='paused'){
    audioContext.resume();
    playState='playing';
    return;
  }

  if(source){source.onended=null;try{source.stop();}catch(e){}source.disconnect();}
  source=audioContext.createBufferSource();
  source.buffer=currentBuffer;
  source.connect(analyser);analyser.connect(audioContext.destination);
  if(audioContext.state==='suspended')audioContext.resume();
  source.start(0);audioStartTime=audioContext.currentTime;
  playState='playing';
  source.onended=()=>{playState='idle';playBtn.textContent='\u25b6\uFE0E Play';controlsEl.classList.remove('hidden');};
});

document.getElementById('replace-btn').addEventListener('click',()=>{fileInput.click();});

renderer.domElement.addEventListener('click',()=>{
  if(playState==='playing'){
    audioContext.suspend();
    playState='paused';
    playBtn.textContent='\u25b6\uFE0E Resume';
    controlsEl.classList.add('visible');
    controlsEl.classList.remove('hidden');
  }
});

window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight);uniforms.uViewport.value.set(window.innerWidth,window.innerHeight);});

function storyArc(p) {
  p=Math.max(0,Math.min(1,p));
  const sm=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  return {
    harmony:    Math.max(0.05, 0.2+0.2*sm(0,0.15,p)+0.55*sm(0.15,0.4,p)+0.1*sm(0.4,0.6,p)-0.25*sm(0.65,0.85,p)-0.35*sm(0.88,1,p)),
    melody:     Math.max(0.05, 0.15+0.2*sm(0.05,0.2,p)+0.55*sm(0.2,0.5,p)-0.15*sm(0.6,0.78,p)-0.35*sm(0.82,1,p)),
    phaseShift: Math.max(0.05, 0.3+0.15*sm(0.1,0.3,p)+0.45*sm(0.3,0.55,p)-0.2*sm(0.65,0.82,p)-0.3*sm(0.88,1,p)),
    overtone:   Math.max(0.05, 0.1+0.15*sm(0.1,0.25,p)+0.6*sm(0.25,0.5,p)+0.1*sm(0.5,0.65,p)-0.3*sm(0.7,0.85,p)-0.35*sm(0.88,1,p)),
    rot: Math.max(0.1, 0.3+0.2*sm(0.1,0.3,p)+0.5*sm(0.3,0.6,p)-0.2*sm(0.7,0.85,p)-0.4*sm(0.88,1,p))
  };
}

const clock=new THREE.Clock(), DRIFT_BASE=108;
const driftCycles={harmony:{period:DRIFT_BASE,depth:0.3},melody:{period:DRIFT_BASE*0.786,depth:0.3},phaseShift:{period:DRIFT_BASE*1.272,depth:0.25},overtone:{period:DRIFT_BASE*0.618,depth:0.3}};
const uMap={harmony:'uHarmony',melody:'uMelody',phaseShift:'uPhaseShift',overtone:'uOvertone'};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed=clock.getElapsedTime(); uniforms.uTime.value=elapsed;
  let arc={harmony:1,melody:1,phaseShift:1,overtone:1,rot:1};
  if(playState==='playing'&&audioDuration>0&&audioStartTime>0){const pr=Math.min((audioContext.currentTime-audioStartTime)/audioDuration,1);const raw=storyArc(pr);for(const k in raw)arc[k]=1+(raw[k]-1)*bakedEpoch;}
  const TP=Math.PI*2;
  const _ds = (playState === 'playing' && audioDuration > 0) ? DRIFT_BASE / Math.max(12, Math.min(120, audioDuration * 0.4)) : 1, dt = elapsed * _ds, _dp = _driftPhases;
  for(const k in driftCycles){const{period,depth}=driftCycles[k];const sd=depth*(0.3+bakedFlux*1.4);const d=(Math.sin(dt * TP / period + (_dp[k] || 0))*0.65+Math.sin(dt * TP / (period * 2.17) + 1.3 + (_dp[k] || 0))*0.35)*sd;uniforms[uMap[k]].value=Math.max(0.01,seedCenter[k]*(arc[k]||1)*(1+d));}
  if(analyser&&dataArray){analyser.getByteFrequencyData(dataArray);for (let i = 0; i < 64; i++) { const a = i < 2 ? _bassSm : _sceneSm; _smoothedFreq[i] = a * _smoothedFreq[i] + (1 - a) * dataArray[i]; frequencyUniform[i] = _smoothedFreq[i]; }}
  const driftAmt=0.08*(0.4+bakedFlux*0.8);
  particles.position.x=Math.sin(dt * TP / (DRIFT_BASE*1.4) + (_dp._px || 0))*driftAmt;
  particles.position.y=Math.sin(dt * TP / (DRIFT_BASE*1.0) +1.7 + (_dp._py || 0))*driftAmt*0.7;
  const breathe=1.0+Math.sin(dt * TP / (DRIFT_BASE*1.8) + (_dp._br || 0))*0.05*(arc.rot||1);
  particles.scale.setScalar(breathe);
  particles.rotation.y=elapsed*rotSpeedY*(arc.rot||1)*0.2;
  particles.rotation.x=elapsed*rotSpeedX*0.35*(arc.rot||1)*0.2;
  renderer.render(scene,camera);
}

function _vjApply() {
  const s = computeSeedValues();
  uniforms.uHarmony.value = s.harmony; uniforms.uMelody.value = s.melody;
  uniforms.uPhaseShift.value = s.phaseShift; uniforms.uOvertone.value = s.overtone;
  uniforms.uSpectrum.value = s.spectrum; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { harmony: s.harmony, melody: s.melody, phaseShift: s.phaseShift, overtone: s.overtone };
  bakedEpoch = s.epoch; bakedFlux = s.flux;
  const gk = String(s.detail);
  if (gk !== _lastGeoKey) { buildParticles(s.detail); _lastGeoKey = gk; }
  _sceneSm = s.smoothing;
}

window.SCENE = {
  scene, camera, renderer, uniforms, frequencyUniform, _bassSm, get _sceneSm() { return _sceneSm; },
  get particles() { return particles; },
  get seedCenter() { return seedCenter; },
  get rotSpeedY() { return rotSpeedY; },
  get rotSpeedX() { return rotSpeedX; },
  get bakedArcScale() { return bakedEpoch; },
  get bakedDriftScale() { return bakedFlux; },
  driftCycles, DRIFT_BASE, get _driftPhases() { return _driftPhases; },
  uniformMap: uMap,
  rotXMult: 0.07, rotDriftScale: 0, tiltDriftScale: 0,
  rotYMult: 0.2, posDrift: { amt: 0.08, px: 1.4, py: 1.0, ys: 0.7 }, breathe: { period: 1.8, amp: 0.05 },
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
  sceneName: 'mathematical-pony'
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
