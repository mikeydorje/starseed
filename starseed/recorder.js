const Recorder = (() => {
  'use strict';

  const FPS = 60;
  const VIDEO_BITRATE = 12_000_000;
  const AUDIO_BITRATE = 128_000;
  const FORMATS = [
    { name: '16x9', label: '16:9',  width: 1920, height: 1080 },
    { name: '1x1',  label: '1:1',   width: 1080, height: 1080 },
    { name: '9x16', label: '9:16',  width: 1080, height: 1920 },
  ];

  // Compute FOV with optional Aperture Scale.
  // lock=0 → normal (portrait corrected wider, landscape untouched).
  // lock=1 → zoomed: portrait reverts to raw baseFov, landscape narrows symmetrically,
  //           square treated as 16:9 landscape (since 1:1 is the identity point).
  const SQUARE_PSEUDO_ASPECT = 1920 / 1080; // treat 1:1 like 16:9 when locked
  function adjustedFov(baseFov, aspect, lock) {
    const t = lock || 0;
    const effectiveAspect = (t && aspect === 1) ? SQUARE_PSEUDO_ASPECT : aspect;
    const rad = baseFov * Math.PI / 180;
    const corrected = 2 * Math.atan(Math.tan(rad / 2) / effectiveAspect) * 180 / Math.PI;
    if (effectiveAspect < 1) {
      // Portrait: default=corrected(wider), locked=baseFov(zoomed)
      return corrected + (baseFov - corrected) * t;
    }
    // Landscape (or pseudo-landscape for 1:1): default=baseFov, locked=corrected(narrower → zoomed)
    return baseFov + (corrected - baseFov) * t;
  }

  let muxerModule = null;
  // Aperture Scale: 0 = normal (corrected FOV), 1 = experimental reframing aesthetic
  // Stored as float for future fine-tuning (interpolate between corrected and raw)
  let zoomLock = 0.5;

  let recording = false;
  let cancelRef = { cancelled: false };
  let recordBtn = null;
  let pauseBtn = null;
  let overlayEl = null;
  let paramsDirty = false;
  let lastPlayState = null;

  /* ── Right-side control panel + popout state ── */
  let ctrlPanel = null;
  let ctrlPopup = null;
  let ctrlPopupTimer = null;
  let panelSliders = [];
  let panelApplyPending = false;
  let arcParamDiv = null;
  const TOUCH_ONLY = 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;

  function isSupported() {
    return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  }

  async function getMuxerModule() {
    if (!muxerModule) {
      muxerModule = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm');
    }
    return muxerModule;
  }

  function fft(input) {
    const N = input.length;
    const real = new Float64Array(N);
    const imag = new Float64Array(N);
    const bits = Math.round(Math.log2(N));
    for (let i = 0; i < N; i++) {
      let j = 0, n = i;
      for (let b = 0; b < bits; b++) { j = (j << 1) | (n & 1); n >>= 1; }
      real[j] = input[i];
    }
    for (let size = 2; size <= N; size *= 2) {
      const half = size >> 1;
      const angle = -2 * Math.PI / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const cos = Math.cos(angle * j);
          const sin = Math.sin(angle * j);
          const idx = i + j + half;
          const re = real[idx] * cos - imag[idx] * sin;
          const im = real[idx] * sin + imag[idx] * cos;
          real[idx] = real[i + j] - re;
          imag[idx] = imag[i + j] - im;
          real[i + j] += re;
          imag[i + j] += im;
        }
      }
    }
    return { real, imag };
  }

  function preAnalyzeAudio(buffer, smoothing, bassSmoothing, onProgress, fps) {
    fps = fps || FPS;
    const fftSize = 128;
    const bins = fftSize >> 1; // 64
    const totalFrames = Math.ceil(buffer.duration * fps);
    const frameData = new Array(totalFrames);

    // Mix to mono
    const mono = new Float32Array(buffer.length);
    const chScale = 1 / buffer.numberOfChannels;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let s = 0; s < buffer.length; s++) mono[s] += d[s] * chScale;
    }

    // Blackman window
    const win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / fftSize)
                     + 0.08 * Math.cos(4 * Math.PI * i / fftSize);
    }

    // Effective smoothing constant at frame rate
    // AnalyserNode smooths every audio block (fftSize samples).
    // Between frames there are roughly (sampleRate/fftSize)/fps blocks.
    const blocksPerFrame = (buffer.sampleRate / fftSize) / fps;
    const effSmoothing = Math.pow(smoothing, blocksPerFrame);
    const effBassSm = Math.pow(bassSmoothing, blocksPerFrame);

    const prevSmoothed = new Float64Array(bins);
    const minDB = -100, maxDB = -30, rangeDB = maxDB - minDB;

    for (let frame = 0; frame < totalFrames; frame++) {
      const center = Math.round(frame / fps * buffer.sampleRate);
      const start = center - (fftSize >> 1);

      const samples = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        const si = start + i;
        samples[i] = (si >= 0 && si < mono.length ? mono[si] : 0) * win[i];
      }

      const { real, imag } = fft(samples);

      const byteData = new Uint8Array(bins);
      for (let i = 0; i < bins; i++) {
        const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / fftSize;
        const db = 20 * Math.log10(Math.max(mag, 1e-10));
        const eff = i < 2 ? effBassSm : effSmoothing;
        const sm = eff * prevSmoothed[i] + (1 - eff) * db;
        prevSmoothed[i] = sm;
        byteData[i] = Math.max(0, Math.min(255, Math.round((sm - minDB) / rangeDB * 255)));
      }
      frameData[frame] = byteData;

      if (onProgress && frame % 120 === 0) onProgress(frame / totalFrames);
    }
    return frameData;
  }

  function createRenderSetup(config, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      preserveDrawingBuffer: true,
      antialias: true,
    });
    // Match the live scene's pixel ratio so gl_PointSize produces identical results.
    // setSize with (width/dpr, height/dpr) + setPixelRatio(dpr) → drawing buffer = width×height.
    const dpr = config.pixelRatio || 1;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width / dpr, height / dpr, false);

    // Independent uniforms
    const freqUniform = new Float32Array(64);
    // uViewport in CSS pixels (matching live scene which uses window.innerWidth/Height)
    const cssWidth = width / dpr;
    const cssHeight = height / dpr;
    const uniforms = {
      uFrequencyData: { value: freqUniform },
      uTime: { value: 0 },
      uViewport: { value: new THREE.Vector2(cssWidth, cssHeight) },
    };
    for (const [k, v] of Object.entries(config.uniformSnapshot)) {
      if (!uniforms[k]) uniforms[k] = { value: v };
    }

    const material = new THREE.ShaderMaterial({
      vertexShader: config.vertexShader,
      fragmentShader: config.fragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particles = new THREE.Points(config.geometry, material);
    const recScene = new THREE.Scene();
    recScene.add(particles);

    const camera = new THREE.PerspectiveCamera(
      adjustedFov(config.cameraFov, width / height, zoomLock), width / height, config.cameraNear, config.cameraFar
    );
    camera.position.copy(config.cameraPos);
    camera.quaternion.copy(config.cameraQuat);

    return { renderer, scene: recScene, camera, particles, uniforms, freqUniform };
  }

  function setFrameState(setup, config, freqData, time, progress) {
    setup.uniforms.uTime.value = time;
    for (let i = 0; i < 64; i++) {
      setup.freqUniform[i] = freqData ? freqData[i] : 0;
    }

    // Narrative arc
    const arcMult = {};
    for (const k in config.driftCycles) arcMult[k] = 1;
    arcMult.rot = 1;
    const rawArc = config.storyArc(progress);
    for (const k in rawArc) {
      arcMult[k] = 1.0 + (rawArc[k] - 1.0) * config.bakedArcScale;
    }

    // Drift cycles → uniforms
    const TWO_PI = Math.PI * 2;
    const _ad = config.audioDuration || 0;
    const _ds = _ad > 0 ? config.DRIFT_BASE / Math.max(12, Math.min(120, _ad * 0.4)) : 1;
    const dt = time * _ds, _dp = config._driftPhases || {};
    for (const key in config.driftCycles) {
      const { period, depth } = config.driftCycles[key];
      const sd = depth * (0.3 + config.bakedDriftScale * 1.4);
      const drift = (Math.sin(dt * TWO_PI / period + (_dp[key] || 0)) * 0.65
                   + Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0)) * 0.35) * sd;
      const uName = config.uniformMap[key];
      if (uName && setup.uniforms[uName]) {
        setup.uniforms[uName].value =
          Math.max(0.01, config.seedCenter[key] * (arcMult[key] || 1) * (1.0 + drift));
      }
    }

    // Rotation
    const DB = config.DRIFT_BASE;
    const rd = config.rotDriftScale
      ? Math.sin(dt * TWO_PI / (DB * 0.92) + (_dp._rd || 0)) * config.rotDriftScale : 0;
    const td = config.tiltDriftScale
      ? Math.sin(dt * TWO_PI / (DB * 1.38) + 2.0 + (_dp._td || 0)) * config.tiltDriftScale : 0;
    setup.particles.rotation.y = time * config.rotSpeedY * (arcMult.rot || 1) * (1.0 + rd) * (config.rotYMult || 1);
    setup.particles.rotation.x = time * config.rotSpeedX * config.rotXMult * (arcMult.rot || 1) * (1.0 + td);

    // Position drift
    if (config.posDrift) {
      const pd = config.posDrift;
      const driftAmt = pd.amt * (0.4 + config.bakedDriftScale * 0.8);
      setup.particles.position.x = Math.sin(dt * TWO_PI / (DB * pd.px) + (_dp._px || 0)) * driftAmt;
      setup.particles.position.y = Math.sin(dt * TWO_PI / (DB * pd.py) + 1.7 + (_dp._py || 0)) * driftAmt * pd.ys;
      if (pd.pz) setup.particles.position.z = Math.sin(dt * TWO_PI / (DB * pd.pz) + 0.9 + (_dp._pz || 0)) * driftAmt * (pd.zs || 0.4);
    }

    // Scale breathing
    if (config.breathe) {
      const br = config.breathe;
      setup.particles.scale.setScalar(1.0 + Math.sin(dt * TWO_PI / (DB * br.period) + (_dp._br || 0)) * br.amp * (arcMult.rot || 1));
    }

    // Amplitude envelope for shoegaze scenes
    if (setup.uniforms.uEnvelope) {
      let lvl = 0;
      if (freqData) { for (let i = 0; i < 64; i++) lvl += freqData[i]; lvl /= (64 * 255); }
      const tgt = Math.min(lvl * 3.0, 1.0);
      const env = setup._envelope || 0;
      setup._envelope = env + (tgt - env) * (tgt > env ? 0.14 : 0.035);
      setup.uniforms.uEnvelope.value = Math.max(setup._envelope, 0.02);
    }
  }

  async function encodeAudio(buffer, muxer) {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => console.error('AudioEncoder:', e),
    });
    encoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: buffer.sampleRate,
      numberOfChannels: buffer.numberOfChannels,
      bitrate: AUDIO_BITRATE,
    });

    const CHUNK = 1024;
    for (let offset = 0; offset < buffer.length; offset += CHUNK) {
      const size = Math.min(CHUNK, buffer.length - offset);
      const planar = new Float32Array(size * buffer.numberOfChannels);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        planar.set(buffer.getChannelData(ch).subarray(offset, offset + size), ch * size);
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: buffer.sampleRate,
        numberOfFrames: size,
        numberOfChannels: buffer.numberOfChannels,
        timestamp: Math.round(offset / buffer.sampleRate * 1_000_000),
        data: planar,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
    encoder.close();
  }

  async function recordFormat(config, frameData, fmt, audioBuffer, onProgress, fps) {
    fps = fps || FPS;
    const { Muxer, ArrayBufferTarget } = await getMuxerModule();
    const { width, height } = fmt;
    const totalFrames = frameData.length;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height },
      audio: {
        codec: 'aac',
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
      },
      fastStart: 'in-memory',
    });

    let videoCodec = 'avc1.640033';
    let probe = await VideoEncoder.isConfigSupported({
      codec: videoCodec, width, height, bitrate: VIDEO_BITRATE, framerate: fps,
    });
    if (!probe.supported) {
      videoCodec = 'avc1.640028';
      probe = await VideoEncoder.isConfigSupported({
        codec: videoCodec, width, height, bitrate: VIDEO_BITRATE, framerate: fps,
      });
    }
    if (!probe.supported) {
      videoCodec = 'avc1.42001f';
    }

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error('VideoEncoder:', e),
    });
    videoEncoder.configure({
      codec: videoCodec, width, height, bitrate: VIDEO_BITRATE, framerate: fps,
    });

    const setup = createRenderSetup(config, width, height);

    for (let i = 0; i < totalFrames; i++) {
      if (cancelRef.cancelled) break;

      setFrameState(setup, config, frameData[i], i / fps, i / totalFrames);
      setup.renderer.render(setup.scene, setup.camera);

      const frame = new VideoFrame(setup.renderer.domElement, {
        timestamp: Math.round(i * 1_000_000 / fps),
        duration: Math.round(1_000_000 / fps),
      });
      videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      // Back-pressure: don't outrun the encoder
      while (videoEncoder.encodeQueueSize > 10) {
        await new Promise(r => setTimeout(r, 1));
      }
      // Yield to UI periodically
      if (i % 5 === 0) {
        onProgress(i / totalFrames);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    await videoEncoder.flush();
    videoEncoder.close();

    if (cancelRef.cancelled) {
      setup.renderer.forceContextLoss();
      setup.renderer.dispose();
      return null;
    }

    // Encode & mux audio
    await encodeAudio(audioBuffer, muxer);

    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });

    setup.renderer.forceContextLoss();
    setup.renderer.dispose();
    return blob;
  }

  function snapshotConfig() {
    const S = window.SCENE;
    const uniformSnapshot = {};
    for (const [k, v] of Object.entries(S.uniforms)) {
      if (k === 'uFrequencyData' || k === 'uViewport') continue;
      if (typeof v.value === 'number') uniformSnapshot[k] = v.value;
    }
    return {
      vertexShader:    S.particles.material.vertexShader,
      fragmentShader:  S.particles.material.fragmentShader,
      geometry:        S.particles.geometry,
      cameraFov:       S.camera.fov,
      cameraNear:      S.camera.near,
      cameraFar:       S.camera.far,
      cameraPos:       S.camera.position.clone(),
      cameraQuat:      S.camera.quaternion.clone(),
      uniformSnapshot,
      pixelRatio:      window.devicePixelRatio || 1,
      seedCenter:      Object.assign({}, S.seedCenter),
      rotSpeedY:       S.rotSpeedY,
      rotSpeedX:       S.rotSpeedX,
      bakedArcScale:   S.bakedArcScale,
      bakedDriftScale: S.bakedDriftScale,
      driftCycles:     S.driftCycles,
      DRIFT_BASE:      S.DRIFT_BASE,
      uniformMap:      S.uniformMap,
      rotXMult:        S.rotXMult,
      rotDriftScale:   S.rotDriftScale,
      tiltDriftScale:  S.tiltDriftScale,
      storyArc:        S.storyArc,
      sceneName:       S.sceneName,
      audioDuration:   S.audioDuration || 0,
      _driftPhases:    Object.assign({}, S._driftPhases || {}),
      rotYMult:        S.rotYMult || 1,
      posDrift:        S.posDrift || null,
      breathe:         S.breathe || null,
    };
  }

  let renderQueue = [];
  let processing = false;
  let cachedFrameData = null;
  let cachedConfig = null;
  let cachedAudioBuffer = null;
  let cachedSmoothing = 0.85;
  let blobUrls = [];
  let formatStates = {};

  function resetFormatStates() {
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    blobUrls = [];
    cachedFrameData = null;
    cachedConfig = null;
    cachedAudioBuffer = null;
    renderQueue = [];
    processing = false;
    FORMATS.forEach(f => {
      formatStates[f.name] = { state: 'idle', blob: null, url: null, progress: 0 };
    });
  }
  resetFormatStates();

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      #rec-btn {
        position:fixed; bottom:16px; right:104px; z-index:20;
        width:36px; height:36px; padding:0;
        background:rgba(10,10,20,0.5); border:1px solid rgba(255,255,255,0.1);
        border-radius:8px; cursor:pointer;
        display:none; align-items:center; justify-content:center;
        color:rgba(255,80,80,0.7); transition:all 0.3s; backdrop-filter:blur(6px);
      }
      #rec-btn:hover {
        color:#ff4444; background:rgba(255,50,50,0.2); border-color:rgba(255,80,80,0.4);
      }
      #rec-btn .rec-dot { width:14px; height:14px; border-radius:50%; background:currentColor; }
      #rec-pause-btn {
        position:fixed; bottom:16px; right:148px; z-index:20;
        width:36px; height:36px; padding:0;
        background:rgba(10,10,20,0.5); border:1px solid rgba(255,255,255,0.1);
        border-radius:8px; cursor:pointer;
        display:none; align-items:center; justify-content:center;
        color:rgba(255,255,255,0.5); font-size:16px; transition:all 0.3s; backdrop-filter:blur(6px);
        font-family:'Segoe UI',sans-serif; line-height:1;
      }
      #rec-pause-btn:hover {
        color:#fff; background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.3);
      }
      /* ── Right-side control panel ── */
      #ctrl-panel {
        position:fixed; bottom:64px; right:16px; z-index:19;
        width:min(280px,65vw); max-height:calc(100vh - 96px);
        background:rgba(8,10,18,0.88); border:1px solid rgba(255,255,255,0.06);
        border-radius:12px; backdrop-filter:blur(16px);
        overflow-y:auto; overflow-x:hidden; padding:16px 14px;
        font-family:'Segoe UI',sans-serif; color:#ccc;
        display:none; flex-direction:column; gap:0;
        scrollbar-width:thin; scrollbar-color:rgba(255,255,255,0.1) transparent;
        transition:transform 0.3s ease, opacity 0.3s ease;
      }
      #ctrl-panel::-webkit-scrollbar { width:4px; }
      #ctrl-panel::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }
      #ctrl-panel .cp-title {
        font-size:11px; text-transform:uppercase; letter-spacing:2px;
        font-weight:500; text-align:center; margin-bottom:12px;
      }
      #ctrl-panel .cp-sep {
        height:1px; background:rgba(255,255,255,0.06); margin:10px 0;
      }
      #ctrl-panel .param { margin-bottom:10px; }
      #ctrl-panel .param label {
        display:flex; justify-content:space-between; align-items:baseline;
        font-size:12px; margin-bottom:3px;
      }
      #ctrl-panel .param label span.name { font-weight:600; }
      #ctrl-panel .param label span.val {
        color:#555; font-size:10px; font-variant-numeric:tabular-nums;
      }
      #ctrl-panel .param .desc {
        font-size:9px; color:#555; margin-bottom:3px; line-height:1.3; font-style:italic;
      }
      #ctrl-panel .param input[type=range] {
        -webkit-appearance:none; appearance:none;
        width:100%; height:3px; border-radius:2px;
        background:rgba(255,255,255,0.08); outline:none;
      }
      #ctrl-panel .param input[type=range]::-webkit-slider-thumb {
        -webkit-appearance:none; width:12px; height:12px;
        border-radius:50%; cursor:pointer;
      }
      #ctrl-panel .cp-randomize {
        display:flex; align-items:center; justify-content:center; gap:5px;
        width:100%; padding:6px 0; margin-bottom:0;
        font-family:inherit; font-size:10px; font-weight:500;
        letter-spacing:1px; text-transform:uppercase;
        color:rgba(255,255,255,0.3); background:none;
        border:1px solid rgba(255,255,255,0.06); border-radius:6px;
        cursor:pointer; transition:all 0.3s;
      }
      #ctrl-panel .cp-randomize:hover {
        color:rgba(255,255,255,0.6); border-color:rgba(255,255,255,0.15);
        background:rgba(255,255,255,0.04);
      }
      #ctrl-panel .cp-fmt-row {
        display:flex; gap:4px; align-items:center; flex-wrap:wrap;
      }
      #ctrl-panel .fmt-prev-btn {
        height:28px; padding:0 7px; display:inline-flex; align-items:center; justify-content:center;
        font-family:'Segoe UI',sans-serif; font-size:10px;
        letter-spacing:0.5px; color:rgba(255,255,255,0.3);
        background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
        border-radius:5px; cursor:pointer; transition:all 0.3s; line-height:1; box-sizing:border-box;
      }
      #ctrl-panel .fmt-prev-btn:hover { color:rgba(255,255,255,0.6); border-color:rgba(255,255,255,0.15); }
      #ctrl-panel .fmt-prev-btn.active { color:#b8b0e8; border-color:rgba(123,111,219,0.4); background:rgba(123,111,219,0.15); }
      #ctrl-panel .cp-zoom-row {
        display:flex; align-items:center; gap:6px; margin-top:6px;
        font-size:10px; color:rgba(255,255,255,0.35); letter-spacing:0.5px;
        padding-right:2px;
      }
      #ctrl-panel .cp-zoom-label { white-space:nowrap; min-width:32px; }
      #ctrl-panel .cp-zoom-slider {
        flex:1; min-width:0; height:3px; -webkit-appearance:none; appearance:none;
        background:rgba(255,255,255,0.12); border-radius:2px; outline:none; cursor:pointer;
      }
      #ctrl-panel .cp-zoom-slider::-webkit-slider-thumb {
        -webkit-appearance:none; width:10px; height:10px;
        border-radius:50%; background:#e8c080; cursor:pointer;
      }
      #ctrl-panel .cp-zoom-slider::-moz-range-thumb {
        width:10px; height:10px; border:none;
        border-radius:50%; background:#e8c080; cursor:pointer;
      }
      #ctrl-panel .cp-bd-row { display:flex; align-items:center; gap:6px; margin-top:6px; }
      #ctrl-panel .bd-toggle {
        height:28px; width:28px; padding:0; display:inline-flex; align-items:center; justify-content:center;
        background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
        border-radius:5px; cursor:pointer; transition:all 0.3s;
        color:rgba(255,255,255,0.25);
      }
      #ctrl-panel .bd-toggle:hover { color:rgba(255,255,255,0.6); border-color:rgba(255,255,255,0.15); }
      #ctrl-panel .bd-toggle.active { color:#b8b0e8; border-color:rgba(123,111,219,0.4); background:rgba(123,111,219,0.15); }
      #ctrl-panel .bd-toggle svg { width:14px; height:14px; }
      #ctrl-panel .cp-bd-label { font-size:10px; color:rgba(255,255,255,0.25); letter-spacing:0.5px; }

      #ctrl-panel .cp-popout {
        display:flex; align-items:center; justify-content:center; gap:5px;
        width:100%; padding:6px 0; margin-top:4px;
        font-family:inherit; font-size:10px; font-weight:600;
        letter-spacing:1px; text-transform:uppercase;
        color:rgba(255,255,255,0.25); background:none;
        border:1px solid rgba(255,255,255,0.06); border-radius:6px;
        cursor:pointer; transition:all 0.3s;
      }
      #ctrl-panel .cp-popout:hover:not(.disabled) {
        color:rgba(255,255,255,0.6); border-color:rgba(255,255,255,0.15);
        background:rgba(255,255,255,0.04);
      }
      #ctrl-panel .cp-popout.disabled {
        opacity:0.25; cursor:default; pointer-events:none;
      }
      #ctrl-panel .cp-popout svg { width:11px; height:11px; }
      #rec-overlay {
        position:fixed; inset:0; z-index:1000;
        background:rgba(5,5,12,0.92); backdrop-filter:blur(20px);
        display:none; flex-direction:column; align-items:center; justify-content:center;
        font-family:'Segoe UI',sans-serif; color:#ccc;
      }
      #rec-overlay.active { display:flex; }
      .rec-title {
        font-size:13px; text-transform:uppercase; letter-spacing:3px;
        color:#666; margin-bottom:32px;
      }
      .rec-formats { width:380px; }
      .rec-format-card {
        display:flex; align-items:center; gap:12px;
        padding:14px 16px; margin-bottom:10px;
        background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);
        border-radius:10px; transition:border-color 0.3s;
      }
      .rec-format-card.rendering { border-color:rgba(123,111,219,0.3); }
      .rec-format-card.done { border-color:rgba(80,200,80,0.25); }
      .rec-format-card.error { border-color:rgba(255,80,80,0.25); }
      .rec-format-info { flex:1; min-width:0; }
      .rec-format-label {
        font-size:14px; font-weight:500; color:#b8b0e8; margin-bottom:2px;
      }
      .rec-format-dims { font-size:11px; color:#555; }
      .rec-format-progress {
        width:100%; height:3px; background:rgba(255,255,255,0.06);
        border-radius:2px; margin-top:8px; overflow:hidden; display:none;
      }
      .rec-format-progress.visible { display:block; }
      .rec-format-bar {
        height:100%; width:0%;
        background:linear-gradient(90deg,#7b6fdb,#b8b0e8);
        border-radius:2px; transition:width 0.15s;
      }
      .rec-format-status {
        font-size:10px; color:#555; margin-top:4px; display:none;
        letter-spacing:0.5px;
      }
      .rec-format-status.visible { display:block; }
      .rec-render-btn {
        padding:6px 14px; font-family:inherit; font-size:11px;
        letter-spacing:1px; text-transform:uppercase;
        color:rgba(255,255,255,0.5); background:none;
        border:1px solid rgba(255,255,255,0.12); border-radius:6px;
        cursor:pointer; transition:all 0.3s; white-space:nowrap; flex-shrink:0;
      }
      .rec-render-btn:hover:not(:disabled) {
        color:#b8b0e8; border-color:rgba(123,111,219,0.4); background:rgba(123,111,219,0.1);
      }
      .rec-render-btn:disabled {
        opacity:0.3; cursor:default;
      }
      .rec-render-btn.queued {
        color:#7b6fdb; border-color:rgba(123,111,219,0.3);
      }
      .rec-render-btn.rendering {
        color:#b8b0e8; border-color:rgba(123,111,219,0.4);
        background:rgba(123,111,219,0.1);
      }
      .rec-dl-btn {
        display:none; padding:6px 14px; font-family:inherit; font-size:11px;
        letter-spacing:1px; text-transform:uppercase;
        color:#b8b0e8; background:rgba(123,111,219,0.1);
        border:1px solid rgba(123,111,219,0.2); border-radius:6px;
        text-decoration:none; transition:all 0.3s; white-space:nowrap; flex-shrink:0;
      }
      .rec-dl-btn.visible { display:inline-block; }
      .rec-dl-btn:hover {
        background:rgba(123,111,219,0.25); border-color:rgba(123,111,219,0.4); color:#fff;
      }
      .rec-actions {
        display:flex; gap:10px; justify-content:center;
        margin-top:24px; width:380px;
      }
      .rec-note {
        width:380px; margin-top:14px;
        font-size:10px; line-height:1.55; letter-spacing:0.2px;
        color:rgba(255,255,255,0.32); text-align:center;
      }
      .rec-note strong { color:rgba(255,255,255,0.5); font-weight:600; }
      .rec-action-btn {
        padding:8px 20px; font-family:inherit; font-size:11px;
        letter-spacing:1px; text-transform:uppercase;
        color:rgba(255,255,255,0.4); background:none;
        border:1px solid rgba(255,255,255,0.1); border-radius:8px;
        cursor:pointer; transition:all 0.3s;
      }
      .rec-action-btn:hover {
        color:#fff; background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.2);
      }
      .rec-action-btn.all:hover {
        color:#b8b0e8; border-color:rgba(123,111,219,0.4); background:rgba(123,111,219,0.1);
      }
      .rec-action-btn.cancel:hover {
        color:#fff; border-color:rgba(255,80,80,0.4); background:rgba(255,50,50,0.15);
      }
      .rec-analyze-status {
        font-size:11px; color:#555; letter-spacing:1px; text-align:center;
        margin-bottom:16px; height:16px;
      }
      .rec-analyze-status.active { color:#b8b0e8; }
      .rec-unsupported {
        position:fixed; bottom:16px; right:104px; z-index:20;
        font-family:'Segoe UI',sans-serif; font-size:10px; color:#555;
      }
      body.fmt-preview-active { background:#000 !important; overflow:hidden !important; }
      body.fmt-preview-active canvas {
        position:fixed !important; top:50% !important; left:50% !important;
        transform:translate(-50%,-50%) !important;
        box-shadow:0 0 0 1px rgba(255,255,255,0.35);
        object-fit:contain;
        min-height:0 !important; min-width:0 !important;
      }
    `;
    document.head.appendChild(s);
  }

  /* ── Accent color for panel slider thumbs ── */
  function _panelAccent() {
    const S = window.SCENE;
    if (!S) return { fg: '#b8b0e8', glow: 'rgba(184,176,232,0.5)' };
    const map = {
      'smbh':              { fg: '#b8b0e8', glow: 'rgba(123,111,219,0.5)' },
      'lotus':             { fg: '#c4a0b0', glow: 'rgba(196,122,144,0.5)' },
      'ember':             { fg: '#b8a078', glow: 'rgba(160,128,80,0.4)' },
      'filament':          { fg: '#7ab0d8', glow: 'rgba(80,144,192,0.4)' },
      'spore':             { fg: '#6ab07a', glow: 'rgba(74,144,96,0.4)' },
      'lattice':           { fg: '#8a90b0', glow: 'rgba(96,104,160,0.4)' },
      'sakura':            { fg: '#d4a0b8', glow: 'rgba(232,160,184,0.5)' },
      'pi':                { fg: '#9088c0', glow: 'rgba(112,96,176,0.4)' },
      'tau':               { fg: '#c09050', glow: 'rgba(160,128,64,0.4)' },
      'phi':               { fg: '#80a050', glow: 'rgba(96,144,64,0.4)' },
      'euler':             { fg: '#c06040', glow: 'rgba(160,64,48,0.4)' },
      'feigenbaum':        { fg: '#9050b0', glow: 'rgba(128,64,160,0.4)' },
      'mathematical-pony': { fg: '#e080c0', glow: 'rgba(255,96,200,0.4)' },
      'only-shallow':      { fg: '#e06050', glow: 'rgba(255,60,40,0.4)' },
      'to-here-knows-when':{ fg: '#8070b0', glow: 'rgba(100,80,180,0.4)' },
      'blown-a-wish':      { fg: '#80a058', glow: 'rgba(120,170,80,0.4)' },
      'i-only-said':       { fg: '#7888a8', glow: 'rgba(120,136,168,0.4)' },
      'sometimes':         { fg: '#b08840', glow: 'rgba(180,140,60,0.4)' },
    };
    return map[S.sceneName] || { fg: '#b8b0e8', glow: 'rgba(184,176,232,0.5)' };
  }

  const bdOnSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  const bdOffSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/></svg>';
  const popoutSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  let panelBdBtn = null;

  function createUI() {
    recordBtn = document.createElement('button');
    recordBtn.id = 'rec-btn';
    recordBtn.title = 'Record video';
    recordBtn.innerHTML = '<div class="rec-dot"></div>';
    recordBtn.addEventListener('click', openFormatPicker);
    document.body.appendChild(recordBtn);

    pauseBtn = document.createElement('button');
    pauseBtn.id = 'rec-pause-btn';
    pauseBtn.title = 'Pause';
    pauseBtn.innerHTML = '\u2759\u2759';
    pauseBtn.addEventListener('click', togglePause);
    document.body.appendChild(pauseBtn);

    overlayEl = document.createElement('div');
    overlayEl.id = 'rec-overlay';
    document.body.appendChild(overlayEl);

    /* ── Right-side control panel ── */
    ctrlPanel = document.createElement('div');
    ctrlPanel.id = 'ctrl-panel';
    buildPanel();
    document.body.appendChild(ctrlPanel);

    // Watch for slider changes — mark params dirty so controls hide until next play
    document.querySelectorAll('#controls input[type="range"]').forEach(el => {
      el.addEventListener('input', () => {
        if (!recording) paramsDirty = true;
      });
    });

    setInterval(() => {
      if (!window.SCENE || recording) return;
      const st = window.SCENE.playState;

      // Transition to 'playing' or 'listening' clears dirty flag
      if ((st === 'playing' || st === 'listening') && lastPlayState !== st) {
        paramsDirty = false;
        syncPanelFromControls();
        if (window.innerWidth < window.innerHeight) document.body.classList.add('toolbar-hidden');
        if (activePreviewFmt && _resizedDuringPreview) {
          _resizedDuringPreview = false;
          activatePreview(activePreviewFmt);
        } else if (!activePreviewFmt) {
          const initFmt = window.innerWidth < window.innerHeight ? FORMATS[2] : FORMATS[0];
          activatePreview(initFmt);
        }
      }
      lastPlayState = st;

      const mobileFS = TOUCH_ONLY && !!document.fullscreenElement;
      const showControls = (st === 'playing' || st === 'paused') && !paramsDirty;
      recordBtn.style.display = (showControls && !mobileFS) ? 'flex' : 'none';
      pauseBtn.style.display = (showControls && !mobileFS) ? 'flex' : 'none';
      pauseBtn.innerHTML = st === 'paused' ? '\u25b6\uFE0E' : '\u2759\u2759';
      pauseBtn.title = st === 'paused' ? 'Resume' : 'Pause';

      // Control panel: show during playing or listening, hide when popout is active
      // On mobile fullscreen, hide panel — user taps canvas to pause/resume
      const showPanel = (st === 'playing' || st === 'listening') && !paramsDirty && !(ctrlPopup && !ctrlPopup.closed) && !mobileFS;
      ctrlPanel.style.display = showPanel ? 'flex' : 'none';

      // Hide arc slider during listen mode (narrative arc has no effect without file playback)
      if (arcParamDiv) arcParamDiv.style.display = st === 'listening' ? 'none' : '';

      // Disable popout button when in fullscreen (window.open exits fullscreen)
      const popoutBtn = ctrlPanel.querySelector('.cp-popout');
      if (popoutBtn) popoutBtn.classList.toggle('disabled', !!document.fullscreenElement);

      // Clear preview if neither playback controls nor panel are showing
      if (!showControls && !showPanel && activePreviewFmt) deactivatePreview();
    }, 200);
  }

  /* ── Build panel contents (sliders, format controls, popout button) ── */
  function buildPanel() {
    const S = window.SCENE;
    const accent = _panelAccent();
    ctrlPanel.innerHTML = '';
    panelSliders = [];

    // Inject accent style for thumbs inside panel
    let accentStyle = ctrlPanel.querySelector('.cp-accent-style');
    if (!accentStyle) {
      accentStyle = document.createElement('style');
      accentStyle.className = 'cp-accent-style';
      ctrlPanel.appendChild(accentStyle);
    }
    accentStyle.textContent =
      '#ctrl-panel .param input[type=range]::-webkit-slider-thumb{background:' + accent.fg + ';box-shadow:0 0 5px ' + accent.glow + '}' +
      '#ctrl-panel .cp-title{color:' + accent.fg + '}' +
      '#ctrl-panel .param label span.name{color:' + accent.fg + '}' +
      '#ctrl-panel .cp-zoom-slider::-webkit-slider-thumb{background:' + accent.fg + ';box-shadow:0 0 5px ' + accent.glow + '}' +
      '#ctrl-panel .cp-zoom-slider::-moz-range-thumb{background:' + accent.fg + ';box-shadow:0 0 5px ' + accent.glow + '}' +
      '#ctrl-panel .cp-zoom-label{color:' + accent.fg + '}';

    // Title
    const title = document.createElement('div');
    title.className = 'cp-title';
    title.textContent = S ? S.sceneName.replace(/-/g, ' ') : '';
    ctrlPanel.appendChild(title);

    // Scrape sliders from #controls .param
    const openerParams = document.querySelectorAll('#controls .param');
    for (let i = 0; i < openerParams.length; i++) {
      const srcParam = openerParams[i];
      const srcInput = srcParam.querySelector('input[type=range]');
      if (!srcInput) continue;

      const srcLabel = srcParam.querySelector('label');
      const nameSpan = srcLabel ? srcLabel.querySelector('span.name') : null;
      const descDiv = srcParam.querySelector('.desc');

      const id = srcInput.id;
      const labelText = nameSpan ? nameSpan.textContent : id;
      const descText = descDiv ? descDiv.textContent : '';

      const div = document.createElement('div');
      div.className = 'param';

      const label = document.createElement('label');
      const ns = document.createElement('span');
      ns.className = 'name';
      ns.textContent = labelText;
      const vs = document.createElement('span');
      vs.className = 'val';
      vs.textContent = srcInput.value;
      label.appendChild(ns);
      label.appendChild(vs);
      div.appendChild(label);

      if (descText) {
        const dd = document.createElement('div');
        dd.className = 'desc';
        dd.textContent = descText;
        div.appendChild(dd);
      }

      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = srcInput.min || '0';
      inp.max = srcInput.max || '100';
      inp.value = srcInput.value;
      inp.dataset.target = id;
      div.appendChild(inp);

      // Tag the arc slider so it can be hidden in listen mode
      if (descText.indexOf('Narrative arc') !== -1) arcParamDiv = div;

      ctrlPanel.appendChild(div);
      panelSliders.push({ input: inp, valSpan: vs, targetId: id });
    }

    // Bind panel slider events
    panelSliders.forEach(sl => {
      sl.input.addEventListener('input', () => {
        sl.valSpan.textContent = sl.input.value;
        const target = document.getElementById(sl.targetId);
        if (target) {
          target.value = sl.input.value;
          const valEl = document.getElementById(sl.targetId + '-val');
          if (valEl) valEl.textContent = sl.input.value;
        }
        schedulePanelApply();
      });
    });

    // Randomize button
    const rBtn = document.createElement('button');
    rBtn.className = 'cp-randomize';
    rBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="12" height="12"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>Randomize';
    rBtn.addEventListener('click', () => {
      panelSliders.forEach(sl => {
        const lo = parseInt(sl.input.min, 10);
        const hi = parseInt(sl.input.max, 10);
        const v = Math.floor(lo + Math.random() * (hi - lo));
        sl.input.value = v;
        sl.valSpan.textContent = v;
        const target = document.getElementById(sl.targetId);
        if (target) {
          target.value = v;
          const valEl = document.getElementById(sl.targetId + '-val');
          if (valEl) valEl.textContent = v;
        }
      });
      schedulePanelApply();
    });
    ctrlPanel.appendChild(rBtn);

    // ── Separator ──
    const sep = document.createElement('div');
    sep.className = 'cp-sep';
    ctrlPanel.appendChild(sep);

    // ── Format preview buttons ──
    const fmtRow = document.createElement('div');
    fmtRow.className = 'cp-fmt-row';
    FORMATS.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'fmt-prev-btn';
      btn.textContent = f.label;
      btn.dataset.fmt = f.name;
      btn.title = f.width + '\u00d7' + f.height + ' preview';
      btn.addEventListener('click', () => togglePreview(f));
      fmtRow.appendChild(btn);
    });
    ctrlPanel.appendChild(fmtRow);

    // ── Aperture Scale slider ──
    const zoomRow = document.createElement('div');
    zoomRow.className = 'cp-zoom-row';
    const zlLabel = document.createElement('span');
    zlLabel.className = 'cp-zoom-label';
    zlLabel.textContent = '\u23e3 50';
    const zlSlider = document.createElement('input');
    zlSlider.type = 'range';
    zlSlider.className = 'cp-zoom-slider';
    zlSlider.min = '0';
    zlSlider.max = '100';
    zlSlider.step = '1';
    zlSlider.value = '50';
    zlSlider.title = 'Aperture Scale \u2014 reframes composition across aspect ratios';
    zlSlider.addEventListener('input', () => {
      const ui = parseInt(zlSlider.value, 10);
      zoomLock = -1 + (ui / 100) * 3;
      zlLabel.textContent = '\u23e3 ' + ui;
      if (activePreviewFmt) activatePreview(activePreviewFmt);
    });
    zoomRow.appendChild(zlLabel);
    zoomRow.appendChild(zlSlider);
    ctrlPanel.appendChild(zoomRow);

    // ── Boundary toggle ──
    const bdRow = document.createElement('div');
    bdRow.className = 'cp-bd-row';
    panelBdBtn = document.createElement('button');
    panelBdBtn.className = 'bd-toggle active';
    panelBdBtn.title = 'Toggle boundary';
    panelBdBtn.innerHTML = bdOnSVG;
    panelBdBtn.addEventListener('click', () => {
      if (!S || !S.uniforms || !S.uniforms.uBoundary) return;
      const on = S.uniforms.uBoundary.value > 0.5;
      S.uniforms.uBoundary.value = on ? 0.0 : 1.0;
      panelBdBtn.classList.toggle('active', !on);
      panelBdBtn.innerHTML = on ? bdOffSVG : bdOnSVG;
    });
    bdRow.appendChild(panelBdBtn);
    const bdLabel = document.createElement('span');
    bdLabel.className = 'cp-bd-label';
    bdLabel.textContent = 'Boundary';
    bdRow.appendChild(bdLabel);
    ctrlPanel.appendChild(bdRow);

    // ── Popout button (only on non-touch) ──
    if (!TOUCH_ONLY) {
      const sep2 = document.createElement('div');
      sep2.className = 'cp-sep';
      ctrlPanel.appendChild(sep2);

      const popBtn = document.createElement('button');
      popBtn.className = 'cp-popout';
      popBtn.innerHTML = popoutSVG + ' Pop Out';
      popBtn.title = 'Open controls in separate window';
      popBtn.addEventListener('click', openPopout);
      ctrlPanel.appendChild(popBtn);
    }
  }

  function syncPanelFromControls() {
    panelSliders.forEach(sl => {
      const src = document.getElementById(sl.targetId);
      if (src) {
        sl.input.value = src.value;
        sl.valSpan.textContent = src.value;
      }
    });
  }

  function schedulePanelApply() {
    if (panelApplyPending) return;
    panelApplyPending = true;
    requestAnimationFrame(() => {
      panelApplyPending = false;
      const S = window.SCENE;
      if (S && S.vjApply) S.vjApply();
    });
  }

  /* ── Popout lifecycle ── */
  function openPopout() {
    if (document.fullscreenElement) return;
    if (ctrlPopup && !ctrlPopup.closed) { ctrlPopup.focus(); return; }
    const S = window.SCENE;
    if (!S) return;
    S.vjActive = true;

    ctrlPopup = window.open('vj-controls.html', 'vjcontrols',
      'width=340,height=580,resizable=yes,scrollbars=yes');

    if (!ctrlPopup) {
      S.vjActive = false;
      alert('Popup blocked \u2014 please allow popups for this site.');
      return;
    }

    // Hide panel while popout is open (poll handles this via ctrlPopup ref)
    ctrlPanel.style.display = 'none';

    ctrlPopupTimer = setInterval(() => {
      if (!ctrlPopup || ctrlPopup.closed) {
        clearInterval(ctrlPopupTimer);
        ctrlPopupTimer = null;
        ctrlPopup = null;
        if (window.SCENE) window.SCENE.vjActive = false;
        // Re-sync panel values (popup may have changed sliders)
        syncPanelFromControls();
      }
    }, 500);
  }

  function closePopout() {
    if (ctrlPopup && !ctrlPopup.closed) ctrlPopup.close();
    if (ctrlPopupTimer) { clearInterval(ctrlPopupTimer); ctrlPopupTimer = null; }
    ctrlPopup = null;
    if (window.SCENE) window.SCENE.vjActive = false;
  }

  // Clean up popup on page unload
  window.addEventListener('pagehide', () => {
    closePopout();
  });

  function togglePause() {
    if (!window.SCENE) return;
    const S = window.SCENE;
    const st = S.playState;
    if (st === 'playing' && S.audioContext) {
      // Close popout on pause to avoid stale dual-control state
      closePopout();
      S.audioContext.suspend();
      document.querySelector('canvas').click();
    } else if (st === 'paused') {
      const playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.click();
    }
  }

  let activePreviewFmt = null;
  let _baseFov = null;
  let _resizedDuringPreview = false;
  let _savedPreviewFmt = null;
  let _savedBaseFov = null;

  function activatePreview(fmt) {
    const S = window.SCENE;
    if (!S || !S.renderer) return;

    // Capture the scene's native FOV before any preview changes
    if (_baseFov === null) _baseFov = S.camera.fov;

    activePreviewFmt = fmt;
    document.body.classList.add('fmt-preview-active');

    // Render at exact format resolution (pixel-perfect, deterministic)
    S.renderer.setPixelRatio(1);
    S.renderer.setSize(fmt.width, fmt.height, false); // false = don't touch CSS
    const fmtAspect = fmt.width / fmt.height;
    S.camera.aspect = fmtAspect;
    S.camera.fov = adjustedFov(_baseFov, fmtAspect, zoomLock);
    S.camera.updateProjectionMatrix();
    if (S.uniforms && S.uniforms.uViewport) {
      S.uniforms.uViewport.value.set(fmt.width, fmt.height);
    }

    // CSS scales the canvas to fit visually
    const canvas = S.renderer.domElement;
    const aspect = fmt.width / fmt.height;
    const maxW = window.innerWidth - 32;
    const maxH = window.innerHeight - 32;
    let visW, visH;
    if (maxW / maxH > aspect) {
      visH = maxH; visW = Math.round(visH * aspect);
    } else {
      visW = maxW; visH = Math.round(visW / aspect);
    }
    canvas.style.width = visW + 'px';
    canvas.style.height = visH + 'px';

    document.querySelectorAll('#ctrl-panel .fmt-prev-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.fmt === fmt.name);
    });
  }

  function deactivatePreview() {
    const S = window.SCENE;
    activePreviewFmt = null;
    document.body.classList.remove('fmt-preview-active');

    if (S && S.renderer) {
      S.renderer.setPixelRatio(devicePixelRatio);
      S.renderer.setSize(window.innerWidth, window.innerHeight);
      S.camera.aspect = window.innerWidth / window.innerHeight;
      if (_baseFov !== null) S.camera.fov = _baseFov;
      _baseFov = null;
      S.camera.updateProjectionMatrix();
      if (S.uniforms && S.uniforms.uViewport) {
        S.uniforms.uViewport.value.set(window.innerWidth, window.innerHeight);
      }
    }

    document.querySelectorAll('#ctrl-panel .fmt-prev-btn').forEach(b => b.classList.remove('active'));
  }

  function togglePreview(fmt) {
    if (activePreviewFmt && activePreviewFmt.name === fmt.name) return;
    activatePreview(fmt);
  }

  // Block scene resize handlers while preview is active — re-fit CSS only
  window.addEventListener('resize', (e) => {
    if (activePreviewFmt) {
      e.stopImmediatePropagation();
      // Pause playback on resize — preview state goes stale with new window dimensions
      const S = window.SCENE;
      if (!S || !S.renderer) return;
      if (S.playState === 'playing') {
        _resizedDuringPreview = true;
        togglePause();
      }
      const fmt = activePreviewFmt;
      const aspect = fmt.width / fmt.height;
      const maxW = window.innerWidth - 32;
      const maxH = window.innerHeight - 32;
      let visW, visH;
      if (maxW / maxH > aspect) {
        visH = maxH; visW = Math.round(visH * aspect);
      } else {
        visW = maxW; visH = Math.round(visW / aspect);
      }
      S.renderer.domElement.style.width = visW + 'px';
      S.renderer.domElement.style.height = visH + 'px';
    }
  }, true); // capturing phase — fires before scene handlers

  // ===== Format picker overlay =====
  function openFormatPicker() {
    if (!window.SCENE || !window.SCENE.currentBuffer) return;
    if (window.SCENE.playState === 'listening') return;
    // Pause playback before opening the render overlay
    const S = window.SCENE;
    if (S.playState === 'playing' && S.audioContext) {
      S.audioContext.suspend();
      document.querySelector('canvas').click();
    }
    // Save active preview so we can restore it on close/cancel
    _savedPreviewFmt = activePreviewFmt;
    _savedBaseFov = _baseFov;
    if (activePreviewFmt) deactivatePreview();
    closePopout();
    recording = true;
    cancelRef = { cancelled: false };
    recordBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
    ctrlPanel.style.display = 'none';
    resetFormatStates();
    renderOverlay();
    overlayEl.classList.add('active');
  }

  function renderOverlay() {
    const sceneName = window.SCENE ? (window.SCENE.sceneName || 'scene') : 'scene';
    overlayEl.innerHTML = `
      <div class="rec-title">Render Video</div>
      <div class="rec-analyze-status" id="rec-analyze"></div>
      <div class="rec-formats">
        ${FORMATS.map(f => `
          <div class="rec-format-card" id="rec-card-${f.name}">
            <div class="rec-format-info">
              <div class="rec-format-label">${f.label}</div>
              <div class="rec-format-dims">${f.width}\u00d7${f.height} \u00b7 ${FPS}fps</div>
              <div class="rec-format-progress" id="rec-prog-${f.name}">
                <div class="rec-format-bar" id="rec-bar-${f.name}"></div>
              </div>
              <div class="rec-format-status" id="rec-status-${f.name}"></div>
            </div>
            <button class="rec-render-btn" id="rec-go-${f.name}"
              data-fmt="${f.name}">Render</button>
            <a class="rec-dl-btn" id="rec-dl-${f.name}">Download</a>
          </div>
        `).join('')}
      </div>
      <div class="rec-actions">
        <button class="rec-action-btn all" id="rec-all">Render All</button>
        <button class="rec-action-btn cancel" id="rec-cancel">Cancel</button>
      </div>
      <div class="rec-note">
        Free to use, no watermark, no signup, no install.<br>
        If you post or share your video, please credit and tag <strong>@mikeydorje</strong>.
      </div>
    `;

    FORMATS.forEach((f, i) => {
      document.getElementById('rec-go-' + f.name).addEventListener('click', () => queueFormat(i));
    });
    document.getElementById('rec-all').addEventListener('click', () => {
      FORMATS.forEach((f, i) => queueFormat(i));
    });
    document.getElementById('rec-cancel').addEventListener('click', cancelOrClose);
  }

  function cancelOrClose() {
    const busy = processing || FORMATS.some(f =>
      formatStates[f.name].state === 'rendering' || formatStates[f.name].state === 'queued');
    if (busy) {
      cancelRef.cancelled = true;
      renderQueue.length = 0;
      FORMATS.forEach(f => {
        if (formatStates[f.name].state === 'queued') {
          formatStates[f.name].state = 'idle';
          updateCard(f.name);
        }
      });
    } else {
      // Close: nothing is rendering
      closeOverlay();
    }
  }

  function updateActionButton() {
    const btn = document.getElementById('rec-cancel');
    if (!btn) return;
    const busy = processing || FORMATS.some(f =>
      formatStates[f.name].state === 'rendering' || formatStates[f.name].state === 'queued');
    btn.textContent = busy ? 'Cancel' : 'Close';
    btn.className = 'rec-action-btn' + (busy ? ' cancel' : '');
  }

  function closeOverlay() {
    overlayEl.classList.remove('active');
    overlayEl.innerHTML = '';
    recording = false;
    // Keep blob URLs alive briefly so any in-progress downloads complete
    const urls = blobUrls.slice();
    blobUrls = [];
    setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 30000);
    resetFormatStates();

    // Restore the preview format that was active before the overlay opened
    if (_savedPreviewFmt) {
      _baseFov = _savedBaseFov;
      activatePreview(_savedPreviewFmt);
      _savedPreviewFmt = null;
      _savedBaseFov = null;
    }
  }

  function updateCard(name) {
    const st = formatStates[name];
    const card = document.getElementById('rec-card-' + name);
    const btn = document.getElementById('rec-go-' + name);
    const dl = document.getElementById('rec-dl-' + name);
    const prog = document.getElementById('rec-prog-' + name);
    const bar = document.getElementById('rec-bar-' + name);
    const status = document.getElementById('rec-status-' + name);
    if (!card) return;

    card.className = 'rec-format-card' + (st.state === 'rendering' ? ' rendering' : '')
      + (st.state === 'done' ? ' done' : '') + (st.state === 'error' ? ' error' : '');

    // Render button state
    if (st.state === 'idle') {
      btn.textContent = 'Render';
      btn.disabled = false;
      btn.className = 'rec-render-btn';
      btn.style.display = '';
    } else if (st.state === 'queued') {
      btn.textContent = 'Queued';
      btn.disabled = true;
      btn.className = 'rec-render-btn queued';
      btn.style.display = '';
    } else if (st.state === 'rendering') {
      btn.textContent = 'Rendering\u2026';
      btn.disabled = true;
      btn.className = 'rec-render-btn rendering';
      btn.style.display = '';
    } else if (st.state === 'done') {
      btn.style.display = 'none';
    } else if (st.state === 'error') {
      btn.textContent = 'Retry';
      btn.disabled = false;
      btn.className = 'rec-render-btn';
      btn.style.display = '';
    }

    // Progress bar
    const showProgress = st.state === 'rendering' || st.state === 'done';
    prog.className = 'rec-format-progress' + (showProgress ? ' visible' : '');
    bar.style.width = (st.progress * 100).toFixed(1) + '%';

    // Status text
    if (st.state === 'rendering') {
      status.className = 'rec-format-status visible';
      status.textContent = Math.round(st.progress * 100) + '%';
    } else if (st.state === 'done') {
      status.className = 'rec-format-status visible';
      const sz = st.blob ? st.blob.size : 0;
      status.textContent = sz > 1048576 ? (sz / 1048576).toFixed(1) + ' MB' : (sz / 1024).toFixed(0) + ' KB';
      status.style.color = 'rgba(80,200,80,0.7)';
    } else if (st.state === 'error') {
      status.className = 'rec-format-status visible';
      status.textContent = 'Failed — try again';
      status.style.color = 'rgba(255,80,80,0.7)';
    } else {
      status.className = 'rec-format-status';
      status.style.color = '';
    }

    // Download button
    if (st.state === 'done' && st.url) {
      const S = window.SCENE;
      const sceneName = S ? (S.sceneName || 'scene') : 'scene';
      const audioBase = (S && S.currentFileName) ? S.currentFileName.replace(/\.[^.]+$/, '') : '';
      dl.href = st.url;
      dl.download = (audioBase ? audioBase + '-' : '') + sceneName + '-' + name + '.mp4';
      dl.textContent = '\u2b07\uFE0E Download';
      dl.className = 'rec-dl-btn visible';
    } else {
      dl.className = 'rec-dl-btn';
    }

    updateActionButton();
  }

  function setAnalyzeStatus(text, active) {
    const el = document.getElementById('rec-analyze');
    if (!el) return;
    el.textContent = text;
    el.className = 'rec-analyze-status' + (active ? ' active' : '');
  }

  function queueFormat(fmtIdx) {
    const f = FORMATS[fmtIdx];
    const st = formatStates[f.name];
    if (st.state === 'rendering' || st.state === 'queued' || st.state === 'done') return;
    st.state = 'queued';
    st.progress = 0;
    st.blob = null;
    if (st.url) { URL.revokeObjectURL(st.url); st.url = null; }
    updateCard(f.name);
    renderQueue.push(fmtIdx);
    processQueue();
  }

  async function processQueue() {
    if (processing || renderQueue.length === 0) return;
    processing = true;
    cancelRef = { cancelled: false };

    try {
      // Pre-analyze once
      if (!cachedFrameData) {
        const S = window.SCENE;
        if (!S || !S.currentBuffer) { processing = false; return; }
        cachedConfig = snapshotConfig();
        cachedAudioBuffer = S.currentBuffer;
        cachedSmoothing = (S._sceneSm !== undefined) ? S._sceneSm : (S.analyser ? S.analyser.smoothingTimeConstant : 0.85);
        const cachedBassSm = (S._bassSm !== undefined) ? S._bassSm : cachedSmoothing;

        setAnalyzeStatus('Pre-analyzing audio\u2026', true);
        await new Promise(r => setTimeout(r, 50));
        cachedFrameData = preAnalyzeAudio(cachedAudioBuffer, cachedSmoothing, cachedBassSm);
        setAnalyzeStatus('Audio analysis complete', false);
      }

      while (renderQueue.length > 0) {
        if (cancelRef.cancelled) break;

        const fmtIdx = renderQueue.shift();
        const f = FORMATS[fmtIdx];
        const st = formatStates[f.name];

        // Could have been cancelled while queued
        if (st.state !== 'queued') continue;

        st.state = 'rendering';
        st.progress = 0;
        updateCard(f.name);

        try {
          const blob = await recordFormat(cachedConfig, cachedFrameData, f, cachedAudioBuffer, p => {
            st.progress = p;
            updateCard(f.name);
          });

          if (cancelRef.cancelled || !blob) {
            st.state = 'idle';
            st.progress = 0;
            updateCard(f.name);
            continue;
          }

          st.state = 'done';
          st.progress = 1;
          st.blob = blob;
          st.url = URL.createObjectURL(blob);
          blobUrls.push(st.url);
          updateCard(f.name);
        } catch (err) {
          console.error('Render failed for ' + f.name + ':', err);
          st.state = 'error';
          updateCard(f.name);
        }
      }

      if (cancelRef.cancelled) {
        setAnalyzeStatus('Cancelled', false);
      }
    } catch (err) {
      console.error('Processing error:', err);
      setAnalyzeStatus('Error: ' + (err.message || err), false);
    }

    processing = false;
    updateActionButton();
  }

  function init() {
    if (!isSupported()) {
      const w = document.createElement('div');
      w.className = 'rec-unsupported';
      w.textContent = 'Video recording requires Chrome or Edge';
      document.body.appendChild(w);
      return;
    }
    injectStyles();
    createUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

  return { isSupported };
})();
