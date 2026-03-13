// --- φ (Phi): Audio-Reactive Golden Ratio Morphing ---
// φ = (1+√5)/2 ≈ 1.618... The golden ratio. Phyllotaxis, golden spiral, five-fold symmetry.
// Audio detuning the golden angle creates visible spiral arms — the sunflower effect.

const vertexShader = `
  uniform float uFrequencyData[64];
  uniform float uTime;
  uniform float uGrowth;
  uniform float uPhyllotaxis;
  uniform float uPentagon;
  uniform float uProportion;
  uniform float uThreshold;
  uniform vec2 uViewport;
  attribute float aIndex;
  attribute float aLayer;
  attribute float aPhase;
  varying float vLayer;
  varying float vFreqAmp;
  varying float vAngle;
  varying float vRadius;

  #define PI  3.14159265358979
  #define TAU 6.28318530717959
  #define PHI 1.6180339887498948
  #define GOLDEN_ANGLE 2.39996322972865 // TAU / (PHI * PHI)

  void main() {
    int idx  = int(clamp(floor(aLayer * 63.0), 0.0, 63.0));
    int idx2 = int(clamp(floor(aIndex / 500.0 * 63.0), 0.0, 63.0));
    int idx3 = int(clamp(floor(mod(aIndex, 8.0) / 8.0 * 63.0), 0.0, 63.0));
    float amp  = uFrequencyData[idx]  / 255.0;
    float amp2 = uFrequencyData[idx2] / 255.0;
    float amp3 = uFrequencyData[idx3] / 255.0;

    float gate = uThreshold * 0.25;
    float gAmp  = max(amp  - gate, 0.0) / max(1.0 - gate, 0.01);
    float gAmp2 = max(amp2 - gate, 0.0) / max(1.0 - gate, 0.01);
    float gAmp3 = max(amp3 - gate, 0.0) / max(1.0 - gate, 0.01);

    // --- Phyllotaxis: point n at angle n × golden_angle, radius ∝ √n ---
    // Audio DETUNES the golden angle → visible spiral arms appear!
    float detune = gAmp * uGrowth * 0.08;
    float angle = aIndex * (GOLDEN_ANGLE + detune);
    float maxN = 500.0;
    float r = sqrt(aIndex / maxN) * (1.0 + uPhyllotaxis * 0.5) * 1.6;

    // --- Five-fold / pentagonal modulation: φ = 2cos(π/5) ---
    float pentWarp = gAmp2 * uPentagon * 0.4 * cos(5.0 * angle + uTime * 0.15);
    r *= (1.0 + pentWarp);

    // --- Golden spiral emphasis: r ∝ φ^(2θ/π) ---
    // Mix spiral form into the phyllotaxis based on audio
    float spiralAngle = angle + aLayer * TAU;
    float spiralR = 0.08 * pow(PHI, mod(spiralAngle, TAU * 3.0) / (PI * 0.5));
    spiralR = min(spiralR, 2.0);
    float spiralMix = gAmp3 * uProportion * 0.6;
    r = mix(r, spiralR, spiralMix);

    // Golden-ratio breathing: oscillate at φ-related frequency
    float breath = sin(uTime * 0.2 / PHI + r * PHI) * 0.04 * (0.3 + gAmp * 0.7);
    r += breath;

    float x = cos(angle) * r;
    float y = sin(angle) * r;
    float z = sin(aIndex * 0.02 + uTime * 0.08) * 0.15 * gAmp;

    vLayer = aLayer;
    vFreqAmp = gAmp;
    vAngle = angle;
    vRadius = r;

    vec4 mvPos = modelViewMatrix * vec4(x, y, z, 1.0);
    float baseSize = 1.0;
    gl_PointSize = (baseSize + gAmp * 2.2) * (230.0 / -mvPos.z) * step(0.003, gAmp) + 0.7;

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
  varying float vAngle;
  varying float vRadius;
  uniform float uSpectrum;
  uniform float uTime;

  #define TAU 6.28318530717959
  #define PHI 1.6180339887498948

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = 1.0 - smoothstep(0.1, 0.45, dist);
    float halo = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.05;

    // Nature palette: green-gold cycling, offset by golden ratio (never repeats)
    float phase = vAngle / TAU + uSpectrum * PHI + vRadius * 0.3 + uTime * 0.01;
    vec3 color = 0.5 + 0.5 * cos(TAU * (phase + vec3(0.0, 0.2, 0.4)));
    // Pull toward natural green-gold
    color = mix(color, vec3(0.55, 0.70, 0.30), 0.35);
    color = mix(color, vec3(0.90, 0.85, 0.50), vFreqAmp * 0.4);
    color = mix(color, vec3(1.0), vFreqAmp * 0.35);

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
  uGrowth:{ value:0.5 }, uPhyllotaxis:{ value:0.5 }, uPentagon:{ value:0.5 }, uProportion:{ value:0.5 },
  uSpectrum:{ value:0.5 }, uThreshold:{ value:0.5 },
  uViewport:{ value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
};

const sliders = {}, valDisplays = {};
for (let i = 1; i <= 8; i++) { const k='p'+i; sliders[k]=document.getElementById(k); valDisplays[k]=document.getElementById(k+'-val'); }
Object.keys(sliders).forEach(k => { const s=sliders[k]; const v=Math.floor(+s.min+Math.random()*(+s.max- +s.min)); s.value=v; valDisplays[k].textContent=v; s.addEventListener('input',()=>{valDisplays[k].textContent=s.value;}); });

function computeSeedValues() {
  const growth=sliders.p1.value/100, phyll=sliders.p2.value/100, pent=sliders.p3.value/100, prop=sliders.p4.value/100;
  return {
    growth:0.1+growth*0.9*(1+prop*0.3), phyllotaxis:0.3+phyll*0.7, pentagon:0.1+pent*0.9*(1-growth*0.2), proportion:0.1+prop*0.9,
    rotSpeedY:0.005+phyll*0.025, rotSpeedX:0.003+phyll*0.012, smoothing:0.88-growth*0.4, detail:Math.floor(200+phyll*400),
    spectrum:sliders.p5.value/100, epoch:sliders.p6.value/100, threshold:sliders.p7.value/100, flux:sliders.p8.value/100
  };
}

let particles;
function buildParticles(detail) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); }
  const totalPts = detail;
  const pos=[], idxA=[], lA=[], pA=[];
  const GA = Math.PI * 2 * (1 - 1/1.6180339887498948);
  for (let i = 0; i < totalPts; i++) {
    const iNorm = i / totalPts;
    const theta = i * GA;
    const r = Math.sqrt(iNorm) * 1.6;
    pos.push(Math.cos(theta)*r, Math.sin(theta)*r, Math.sin(i*0.02)*0.15);
    idxA.push(i); lA.push(Math.sqrt(iNorm)); pA.push(Math.random()*Math.PI*2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('aIndex', new THREE.Float32BufferAttribute(idxA,1));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(lA,1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(pA,1));
  particles = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending }));
  scene.add(particles);
}
buildParticles(400);

let rotSpeedY=0.012, rotSpeedX=0.006, bakedEpoch=0.5, bakedFlux=0.5;
let seedCenter = { growth:0.5, phyllotaxis:0.5, pentagon:0.5, proportion:0.5 };
let audioContext,analyser,dataArray,source,audioDuration=0,audioStartTime=0;
function initAudio(sm) { audioContext=new(window.AudioContext||window.webkitAudioContext)(); analyser=audioContext.createAnalyser(); analyser.fftSize=128; analyser.smoothingTimeConstant=sm; dataArray=new Uint8Array(analyser.frequencyBinCount); }

// --- File Input Handler ---
let currentBuffer=null, currentFileName='';
let playState='idle';
const fileInput=document.getElementById('file-input');
const playBtn=document.getElementById('play-btn');
const controlsEl=document.getElementById('controls');

function showAudioReady(){
  document.getElementById('upload-area').style.display='none';
  document.getElementById('audio-ready').style.display='block';
  document.getElementById('audio-name').textContent=currentFileName;
  playBtn.textContent='\u25b6 Play';
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

playBtn.addEventListener('click', () => {
  if(!currentBuffer)return;

  const s=computeSeedValues();
  controlsEl.classList.add('hidden');
  controlsEl.classList.remove('visible');
  uniforms.uGrowth.value=s.growth; uniforms.uPhyllotaxis.value=s.phyllotaxis;
  uniforms.uPentagon.value=s.pentagon; uniforms.uProportion.value=s.proportion;
  uniforms.uSpectrum.value=s.spectrum; uniforms.uThreshold.value=s.threshold;
  rotSpeedY=s.rotSpeedY; rotSpeedX=s.rotSpeedX;
  seedCenter={growth:s.growth, phyllotaxis:s.phyllotaxis, pentagon:s.pentagon, proportion:s.proportion};
  bakedEpoch=s.epoch; bakedFlux=s.flux;
  buildParticles(s.detail);
  analyser.smoothingTimeConstant=s.smoothing;

  if(playState==='paused'){
    audioContext.resume();
    playState='playing';
    return;
  }

  if(source){try{source.stop();}catch(e){}source.disconnect();}
  source=audioContext.createBufferSource();
  source.buffer=currentBuffer;
  source.connect(analyser);analyser.connect(audioContext.destination);
  if(audioContext.state==='suspended')audioContext.resume();
  source.start(0);audioStartTime=audioContext.currentTime;
  playState='playing';
  source.onended=()=>{playState='idle';playBtn.textContent='\u25b6 Play';controlsEl.classList.remove('hidden');};
});

document.getElementById('replace-btn').addEventListener('click',()=>{fileInput.click();});

renderer.domElement.addEventListener('click',()=>{
  if(playState==='playing'){
    audioContext.suspend();
    playState='paused';
    playBtn.textContent='\u25b6 Resume';
    controlsEl.classList.add('visible');
    controlsEl.classList.remove('hidden');
  }
});

window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight);uniforms.uViewport.value.set(window.innerWidth,window.innerHeight);});

// Narrative: Seed → Unfurl → Bloom → Proportion → Golden silence
function storyArc(p) {
  p=Math.max(0,Math.min(1,p));
  const sm=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  return {
    growth:     Math.max(0.05, 0.1+0.2*sm(0,0.15,p)+0.6*sm(0.15,0.45,p)-0.2*sm(0.6,0.8,p)-0.4*sm(0.85,1,p)),
    phyllotaxis:Math.max(0.1, 0.3+0.15*sm(0.05,0.2,p)+0.5*sm(0.2,0.5,p)-0.15*sm(0.6,0.78,p)-0.35*sm(0.82,1,p)),
    pentagon:   Math.max(0.05, 0.15+0.25*sm(0.1,0.3,p)+0.55*sm(0.3,0.55,p)-0.2*sm(0.65,0.82,p)-0.4*sm(0.85,1,p)),
    proportion: Math.max(0.05, 0.2+0.2*sm(0.1,0.25,p)+0.5*sm(0.25,0.5,p)+0.1*sm(0.5,0.65,p)-0.35*sm(0.7,0.85,p)-0.4*sm(0.88,1,p)),
    rot: Math.max(0.1, 0.3+0.2*sm(0.1,0.3,p)+0.5*sm(0.3,0.6,p)-0.2*sm(0.7,0.85,p)-0.4*sm(0.88,1,p))
  };
}

const clock=new THREE.Clock(), DRIFT_BASE=240;
const driftCycles={growth:{period:DRIFT_BASE,depth:0.3},phyllotaxis:{period:DRIFT_BASE*0.786,depth:0.3},pentagon:{period:DRIFT_BASE*1.272,depth:0.25},proportion:{period:DRIFT_BASE*0.618,depth:0.3}};
const uMap={growth:'uGrowth',phyllotaxis:'uPhyllotaxis',pentagon:'uPentagon',proportion:'uProportion'};

function animate() {
  requestAnimationFrame(animate);
  const elapsed=clock.getElapsedTime(); uniforms.uTime.value=elapsed;
  let arc={growth:1,phyllotaxis:1,pentagon:1,proportion:1,rot:1};
  if(audioDuration>0&&audioStartTime>0){const pr=Math.min((audioContext.currentTime-audioStartTime)/audioDuration,1);const raw=storyArc(pr);for(const k in raw)arc[k]=1+(raw[k]-1)*bakedEpoch;}
  const TP=Math.PI*2;
  for(const k in driftCycles){const{period,depth}=driftCycles[k];const sd=depth*(0.3+bakedFlux*1.4);const d=(Math.sin(elapsed*TP/period)*0.65+Math.sin(elapsed*TP/(period*2.17)+1.3)*0.35)*sd;uniforms[uMap[k]].value=Math.max(0.01,seedCenter[k]*(arc[k]||1)*(1+d));}
  if(analyser&&dataArray){analyser.getByteFrequencyData(dataArray);for(let i=0;i<64;i++)frequencyUniform[i]=dataArray[i];}
  particles.rotation.y=elapsed*rotSpeedY*(arc.rot||1);
  particles.rotation.x=elapsed*rotSpeedX*0.3*(arc.rot||1);
  renderer.render(scene,camera);
}

// --- Recorder API ---
window.SCENE = {
  scene, camera, uniforms, frequencyUniform,
  get particles() { return particles; },
  get seedCenter() { return seedCenter; },
  get rotSpeedY() { return rotSpeedY; },
  get rotSpeedX() { return rotSpeedX; },
  get bakedArcScale() { return bakedEpoch; },
  get bakedDriftScale() { return bakedFlux; },
  driftCycles, DRIFT_BASE,
  uniformMap: uMap,
  rotXMult: 0.3, rotDriftScale: 0, tiltDriftScale: 0,
  storyArc,
  get currentBuffer() { return currentBuffer; },
  get audioDuration() { return audioDuration; },
  get audioContext() { return audioContext; },
  get analyser() { return analyser; },
  get playState() { return playState; },
  sceneName: 'phi'
};

animate();
