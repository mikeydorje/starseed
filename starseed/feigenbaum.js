const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uRate;
  uniform float uIteration;
  uniform float uBifurcation;
  uniform float uAttractor;
  uniform float uThreshold;
  uniform vec2 uViewport;
  uniform float uBoundary;
  attribute float aR;
  attribute float aIter;
  attribute float aLayer;
  attribute float aPhase;
  varying float vR;
  varying float vResult;
  varying float vFreqAmp;
  varying float vLayer;

  #define PI  3.14159265358979
  #define TAU 6.28318530717959
  const float VIS_INPUT_GAIN = 0.89125094; // -1 dB visual attenuation

  void main() {
    int idx  = int(clamp(floor(aR * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(aIter * 63.0), 0.0, 63.0));
    float amp  = uFrequencyData[idx]  / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp  = (max(amp  - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;
    float gAmp2 = (max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01)) * VIS_INPUT_GAIN;

    // Logistic map parameter r ∈ [3.45, 4.0] — zoomed into the branching region
    // Skip the stable root, start where period-doubling gets interesting
    float rBase = 3.45 + aR * 0.55;
    float r = clamp(rBase + gAmp * uRate * 0.15, 3.0, 4.0);

    // Iterate to reach attractor
    float x = aPhase;

    // Transient: 60 iterations to settle onto attractor
    for (int i = 0; i < 60; i++) {
      x = r * x * (1.0 - x);
    }

    // Collect: 8 more iterations, show the one at aIter
    // This reveals period-n orbits: period-1 = one value, period-2 = two, etc.
    float result = x;
    int targetIter = int(floor(aIter * 7.0));
    for (int i = 0; i < 8; i++) {
      x = r * x * (1.0 - x);
      if (i == targetIter) result = x;
    }

    // Map r to ring radius, attractor values to angular scatter
    // This creates a radial bifurcation — branches spread outward
    float ringR = 0.3 + aR * 1.4 * (0.7 + uBifurcation * 0.5);

    // Base angle: mild wrap + strong phase randomness to break spiral symmetry
    float baseAngle = aR * TAU * 0.8 + aPhase * TAU * 2.5 + aIter * TAU * 0.25;
    // Attractor value scatters angularly — branches fan out prominently
    float scatter = (result - 0.5) * TAU * 1.2 * (0.5 + uAttractor * 1.5);
    float finalAngle = baseAngle + scatter;

    // Attractor value also modulates radius — creates branching depth
    float branchDepth = (result - 0.5) * 1.1 * (0.5 + uAttractor * 0.7);
    ringR += branchDepth;

    float posX = cos(finalAngle) * ringR;
    float posY = sin(finalAngle) * ringR;
    float posZ = (aLayer - 0.5) * 0.25;

    // Audio micro-displacement
    posX += sin(aR * 40.0 + uTime * 0.5) * gAmp * 0.04;
    posY += cos(aIter * 30.0 + uTime * 0.3) * gAmp2 * 0.03;

    vR = aR;
    vResult = result;
    vFreqAmp = gAmp;
    vLayer = aLayer;

    vec4 mvPos = modelViewMatrix * vec4(posX, posY, posZ, 1.0);
    gl_PointSize = (0.7 + gAmp * 2.2) * (200.0 / -mvPos.z) * step(0.003, gAmp) + 0.5;

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
  varying float vR;
  varying float vResult;
  varying float vFreqAmp;
  varying float vLayer;
  uniform float uSpectrum;
  uniform float uTime;

  #define TAU 6.28318530717959

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = 1.0 - smoothstep(0.08, 0.42, dist);
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.04;

    // Electric purple/magenta palette — chaos energy
    // Color varies by r position: stable = cool, chaotic = hot
    float chaos = smoothstep(0.5, 0.9, vR); // higher r = more chaotic
    float phase = vResult * 2.0 + uSpectrum * 1.414 + vR * 0.8 + uTime * 0.008;
    vec3 color = 0.5 + 0.5 * cos(TAU * (phase + vec3(0.0, 0.18, 0.38)));
    // Stable region: cool purple; chaotic: hot magenta/white
    color = mix(color, vec3(0.55, 0.25, 0.70), 0.3);
    color = mix(color, vec3(0.95, 0.40, 0.70), chaos * 0.4);
    color = mix(color, vec3(1.0), vFreqAmp * 0.5);

    alpha *= 0.5 + vFreqAmp * 0.5;
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
  uRate:{ value:0.5 }, uIteration:{ value:0.5 }, uBifurcation:{ value:0.5 }, uAttractor:{ value:0.5 },
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
  const rate=sliders.p1.value/100, iteration=sliders.p2.value/100, bifurcation=sliders.p3.value/100, attractor=sliders.p4.value/100;
  return {
    rate:0.1+rate*0.9, iteration:0.2+iteration*0.8, bifurcation:0.3+bifurcation*0.7*(1+rate*0.2), attractor:0.2+attractor*0.8,
    rotSpeedY:0.004+rate*0.018, rotSpeedX:0.002+rate*0.008, smoothing:0.85-iteration*0.35, detail:Math.floor(120+iteration*280),
    spectrum:sliders.p5.value/100, epoch:sliders.p6.value/100, threshold:sliders.p7.value/100, flux:sliders.p8.value/100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); }
  const rSteps = detail;
  const itersPerR = 8;
  const pos=[], rA=[], iterA=[], lA=[], pA=[];
  for (let ri = 0; ri < rSteps; ri++) {
    const rNorm = ri / (rSteps - 1);
    for (let it = 0; it < itersPerR; it++) {
      const itNorm = it / (itersPerR - 1);
      const layerNorm = Math.random();
      pos.push((rNorm-0.5)*3.5, 0, (layerNorm-0.5)*0.25);
      rA.push(rNorm); iterA.push(itNorm); lA.push(layerNorm);
      pA.push(0.15 + Math.random() * 0.7);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('aR', new THREE.Float32BufferAttribute(rA,1));
  geo.setAttribute('aIter', new THREE.Float32BufferAttribute(iterA,1));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(lA,1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(pA,1));
  particles = new THREE.Points(geo, new THREE.ShaderMaterial({vertexShader,fragmentShader,uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
  scene.add(particles);
}
buildParticles(200);

let rotSpeedY=0.008, rotSpeedX=0.004, bakedEpoch=0.5, bakedFlux=0.5;
let seedCenter = { rate:0.5, iteration:0.5, bifurcation:0.5, attractor:0.5 };
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
  uniforms.uRate.value=s.rate; uniforms.uIteration.value=s.iteration;
  uniforms.uBifurcation.value=s.bifurcation; uniforms.uAttractor.value=s.attractor;
  uniforms.uSpectrum.value=s.spectrum; uniforms.uThreshold.value=s.threshold;
  rotSpeedY=s.rotSpeedY; rotSpeedX=s.rotSpeedX;
  seedCenter={rate:s.rate, iteration:s.iteration, bifurcation:s.bifurcation, attractor:s.attractor};
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
    rate:       Math.max(0.05, 0.2+0.15*sm(0,0.15,p)+0.5*sm(0.15,0.4,p)+0.2*sm(0.4,0.65,p)-0.2*sm(0.7,0.85,p)-0.3*sm(0.88,1,p)),
    iteration:  Math.max(0.1, 0.3+0.2*sm(0.05,0.2,p)+0.45*sm(0.2,0.5,p)-0.15*sm(0.6,0.8,p)-0.3*sm(0.85,1,p)),
    bifurcation:Math.max(0.1, 0.25+0.2*sm(0.1,0.25,p)+0.5*sm(0.25,0.55,p)-0.15*sm(0.65,0.82,p)-0.35*sm(0.85,1,p)),
    attractor:  Math.max(0.05, 0.3+0.15*sm(0.1,0.3,p)+0.45*sm(0.3,0.55,p)+0.05*sm(0.55,0.7,p)-0.25*sm(0.75,0.88,p)-0.3*sm(0.9,1,p)),
    rot: Math.max(0.1, 0.3+0.2*sm(0.1,0.3,p)+0.5*sm(0.3,0.6,p)-0.2*sm(0.7,0.85,p)-0.4*sm(0.88,1,p))
  };
}

const clock=new THREE.Clock(), DRIFT_BASE=108;
const driftCycles={rate:{period:DRIFT_BASE,depth:0.25},iteration:{period:DRIFT_BASE*0.786,depth:0.2},bifurcation:{period:DRIFT_BASE*1.272,depth:0.25},attractor:{period:DRIFT_BASE*0.618,depth:0.3}};
const uMap={rate:'uRate',iteration:'uIteration',bifurcation:'uBifurcation',attractor:'uAttractor'};
let _driftPhases = {};
function _initDriftPhases() { const T = Math.PI * 2; for (const k in driftCycles) _driftPhases[k] = Math.random() * T; _driftPhases._px = Math.random() * T; _driftPhases._py = Math.random() * T; _driftPhases._pz = Math.random() * T; _driftPhases._br = Math.random() * T; _driftPhases._rd = Math.random() * T; _driftPhases._td = Math.random() * T; }

function animate() {
  requestAnimationFrame(animate);
  const elapsed=clock.getElapsedTime(); uniforms.uTime.value=elapsed;
  let arc={rate:1,iteration:1,bifurcation:1,attractor:1,rot:1};
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
  particles.rotation.x=elapsed*rotSpeedX*0.3*(arc.rot||1)*0.2;
  renderer.render(scene,camera);
}

function _vjApply() {
  const s = computeSeedValues();
  uniforms.uRate.value = s.rate; uniforms.uIteration.value = s.iteration;
  uniforms.uBifurcation.value = s.bifurcation; uniforms.uAttractor.value = s.attractor;
  uniforms.uSpectrum.value = s.spectrum; uniforms.uThreshold.value = s.threshold;
  rotSpeedY = s.rotSpeedY; rotSpeedX = s.rotSpeedX;
  seedCenter = { rate: s.rate, iteration: s.iteration, bifurcation: s.bifurcation, attractor: s.attractor };
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
  rotXMult: 0.06, rotDriftScale: 0, tiltDriftScale: 0,
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
  sceneName: 'feigenbaum'
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
