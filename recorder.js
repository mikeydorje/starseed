// recorder.js — Offline video recorder for audio-vis scenes
// Records Three.js particle visualizations to MP4 via WebCodecs + mp4-muxer
// Outputs 3 aspect ratios: 16:9, 1:1, 9:16 — all at 1080p, 60fps, maximum quality

const Recorder = (() => {
  'use strict';

  const FPS = 60;
  const VIDEO_BITRATE = 50_000_000;
  const AUDIO_BITRATE = 128_000;
  const FORMATS = [
    { name: '16x9', label: '16:9',  width: 1920, height: 1080 },
    { name: '1x1',  label: '1:1',   width: 1080, height: 1080 },
    { name: '9x16', label: '9:16',  width: 1080, height: 1920 },
  ];

  let muxerModule = null;
  let recording = false;
  let cancelRef = { cancelled: false };
  let recordBtn = null;
  let pauseBtn = null;
  let overlayEl = null;
  let paramsDirty = false;
  let lastPlayState = null;

  // ===== Browser support =====
  function isSupported() {
    return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  }

  // ===== Lazy-load mp4-muxer from CDN =====
  async function getMuxerModule() {
    if (!muxerModule) {
      muxerModule = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm');
    }
    return muxerModule;
  }

  // ===== Radix-2 Cooley-Tukey FFT (128-point) =====
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

  // ===== Pre-analyze audio → per-frame frequency data =====
  function preAnalyzeAudio(buffer, smoothing, onProgress, fps) {
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
        const sm = effSmoothing * prevSmoothed[i] + (1 - effSmoothing) * db;
        prevSmoothed[i] = sm;
        byteData[i] = Math.max(0, Math.min(255, Math.round((sm - minDB) / rangeDB * 255)));
      }
      frameData[frame] = byteData;

      if (onProgress && frame % 120 === 0) onProgress(frame / totalFrames);
    }
    return frameData;
  }

  // ===== Create offscreen rendering setup =====
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
      config.cameraFov, width / height, config.cameraNear, config.cameraFar
    );
    camera.position.copy(config.cameraPos);

    return { renderer, scene: recScene, camera, particles, uniforms, freqUniform };
  }

  // ===== Set all state for one frame =====
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
    for (const key in config.driftCycles) {
      const { period, depth } = config.driftCycles[key];
      const sd = depth * (0.3 + config.bakedDriftScale * 1.4);
      const drift = (Math.sin(time * TWO_PI / period) * 0.65
                   + Math.sin(time * TWO_PI / (period * 2.17) + 1.3) * 0.35) * sd;
      const uName = config.uniformMap[key];
      if (uName && setup.uniforms[uName]) {
        setup.uniforms[uName].value =
          Math.max(0.01, config.seedCenter[key] * (arcMult[key] || 1) * (1.0 + drift));
      }
    }

    // Rotation
    const DB = config.DRIFT_BASE;
    const rd = config.rotDriftScale
      ? Math.sin(time * TWO_PI / (DB * 0.92)) * config.rotDriftScale : 0;
    const td = config.tiltDriftScale
      ? Math.sin(time * TWO_PI / (DB * 1.38) + 2.0) * config.tiltDriftScale : 0;
    setup.particles.rotation.y = time * config.rotSpeedY * (arcMult.rot || 1) * (1.0 + rd);
    setup.particles.rotation.x = time * config.rotSpeedX * config.rotXMult * (arcMult.rot || 1) * (1.0 + td);
  }

  // ===== Encode original audio into muxer =====
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

  // ===== Record one aspect ratio → MP4 Blob =====
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

    // Verify codec support: try High Profile L5.1 → L4.0 → Baseline fallback
    let videoCodec = 'avc1.640033'; // High Profile L5.1
    let probe = await VideoEncoder.isConfigSupported({
      codec: videoCodec, width, height, bitrate: VIDEO_BITRATE, framerate: fps,
    });
    if (!probe.supported) {
      videoCodec = 'avc1.640028'; // High Profile L4.0
      probe = await VideoEncoder.isConfigSupported({
        codec: videoCodec, width, height, bitrate: VIDEO_BITRATE, framerate: fps,
      });
    }
    if (!probe.supported) {
      videoCodec = 'avc1.42001f'; // Baseline L3.1 fallback
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

  // ===== Snapshot current scene config =====
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
    };
  }

  // ===== UI: Inject stylesheet =====
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      #rec-btn {
        position:fixed; bottom:16px; right:60px; z-index:20;
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
        position:fixed; bottom:16px; right:104px; z-index:20;
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
      #rec-overlay {
        position:fixed; inset:0; z-index:1000;
        background:rgba(5,5,12,0.92); backdrop-filter:blur(20px);
        display:none; flex-direction:column; align-items:center; justify-content:center;
        font-family:'Segoe UI',sans-serif; color:#ccc;
      }
      #rec-overlay.active { display:flex; }
      .rec-title {
        font-size:13px; text-transform:uppercase; letter-spacing:3px;
        color:#666; margin-bottom:40px;
      }
      .rec-steps { width:340px; margin-bottom:32px; }
      .rec-step {
        display:flex; align-items:center; gap:12px;
        padding:8px 0; font-size:13px; color:#555; transition:color 0.3s;
      }
      .rec-step.active { color:#b8b0e8; }
      .rec-step.done { color:rgba(80,200,80,0.7); }
      .rec-step-icon { width:20px; text-align:center; font-size:11px; }
      .rec-progress {
        width:340px; height:4px; background:rgba(255,255,255,0.06);
        border-radius:2px; margin-bottom:32px; overflow:hidden;
      }
      .rec-progress-bar {
        height:100%; width:0%;
        background:linear-gradient(90deg,#7b6fdb,#b8b0e8);
        border-radius:2px; transition:width 0.15s;
      }
      .rec-cancel-btn {
        padding:8px 24px; font-family:inherit; font-size:12px;
        letter-spacing:1px; text-transform:uppercase;
        color:rgba(255,255,255,0.4); background:none;
        border:1px solid rgba(255,255,255,0.1); border-radius:8px;
        cursor:pointer; transition:all 0.3s;
      }
      .rec-cancel-btn:hover {
        color:#fff; border-color:rgba(255,80,80,0.4); background:rgba(255,50,50,0.15);
      }
      .rec-downloads { text-align:center; }
      .rec-downloads h3 {
        font-size:13px; text-transform:uppercase; letter-spacing:3px;
        color:#666; margin-bottom:28px; font-weight:500;
      }
      .rec-dl-link {
        display:block; padding:12px 24px; margin:12px auto; max-width:340px;
        font-family:inherit; font-size:13px; color:#b8b0e8;
        background:rgba(123,111,219,0.1); border:1px solid rgba(123,111,219,0.2);
        border-radius:10px; text-decoration:none; transition:all 0.3s;
      }
      .rec-dl-link:hover {
        background:rgba(123,111,219,0.25); border-color:rgba(123,111,219,0.4); color:#fff;
      }
      .rec-dl-size { color:#555; font-size:11px; margin-left:8px; }
      .rec-close-btn {
        margin-top:24px; padding:8px 24px; font-family:inherit; font-size:12px;
        letter-spacing:1px; text-transform:uppercase;
        color:rgba(255,255,255,0.4); background:none;
        border:1px solid rgba(255,255,255,0.1); border-radius:8px;
        cursor:pointer; transition:all 0.3s;
      }
      .rec-close-btn:hover { color:#fff; background:rgba(255,255,255,0.08); }
      .rec-unsupported {
        position:fixed; bottom:16px; right:60px; z-index:20;
        font-family:'Segoe UI',sans-serif; font-size:10px; color:#555;
      }
    `;
    document.head.appendChild(s);
  }

  // ===== UI: Create elements =====
  function createUI() {
    recordBtn = document.createElement('button');
    recordBtn.id = 'rec-btn';
    recordBtn.title = 'Record video';
    recordBtn.innerHTML = '<div class="rec-dot"></div>';
    recordBtn.addEventListener('click', startRecording);
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

    // Watch for slider changes — mark params dirty so rec hides until next play
    document.querySelectorAll('#controls input[type="range"]').forEach(el => {
      el.addEventListener('input', () => {
        if (!recording) paramsDirty = true;
      });
    });

    // Poll playState to show/hide record + pause buttons
    setInterval(() => {
      if (!window.SCENE || recording) return;
      const st = window.SCENE.playState;

      // Transition to 'playing' clears dirty flag (user hit Play with new params)
      if (st === 'playing' && lastPlayState !== 'playing') {
        paramsDirty = false;
      }
      lastPlayState = st;

      const showControls = (st === 'playing' || st === 'paused') && !paramsDirty;
      recordBtn.style.display = showControls ? 'flex' : 'none';
      pauseBtn.style.display = showControls ? 'flex' : 'none';
      pauseBtn.innerHTML = st === 'paused' ? '\u25b6' : '\u2759\u2759';
      pauseBtn.title = st === 'paused' ? 'Resume' : 'Pause';
    }, 200);
  }

  // ===== Pause / Resume =====
  function togglePause() {
    if (!window.SCENE) return;
    const S = window.SCENE;
    const st = S.playState;
    if (st === 'playing' && S.audioContext) {
      S.audioContext.suspend();
      // Scene's canvas click handler sets playState, but we trigger it via the audioContext
      // The scene checks audioContext.state in its loop, so suspending is enough.
      // We also need to update playState — dispatch a click on the canvas to use existing logic.
      document.querySelector('canvas').click();
    } else if (st === 'paused') {
      // Click the scene's play button to resume with current params
      const playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.click();
    }
  }

  function showProgress() {
    overlayEl.classList.add('active');
    const steps = [
      { id: 'analyze', text: 'Pre-analyzing audio' },
      ...FORMATS.map(f => ({ id: f.name, text: `Rendering ${f.label} (${f.width}\u00d7${f.height})` })),
    ];
    overlayEl.innerHTML = `
      <div class="rec-title">Recording</div>
      <div class="rec-steps">
        ${steps.map(s => `
          <div class="rec-step" data-step="${s.id}">
            <span class="rec-step-icon">\u25cb</span>
            <span>${s.text}</span>
          </div>
        `).join('')}
      </div>
      <div class="rec-progress"><div class="rec-progress-bar" id="rec-bar"></div></div>
      <button class="rec-cancel-btn" id="rec-cancel">Cancel</button>
    `;
    document.getElementById('rec-cancel').addEventListener('click', () => {
      cancelRef.cancelled = true;
    });
  }

  function setStepState(id, state) {
    const el = overlayEl.querySelector(`[data-step="${id}"]`);
    if (!el) return;
    el.className = 'rec-step ' + state;
    const icon = el.querySelector('.rec-step-icon');
    icon.textContent = state === 'active' ? '\u25c9' : state === 'done' ? '\u2713' : '\u25cb';
  }

  function setProgress(pct) {
    const bar = document.getElementById('rec-bar');
    if (bar) bar.style.width = (pct * 100).toFixed(1) + '%';
  }

  function showDownloads(results, sceneName) {
    const urls = [];
    const fmt = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
    const links = results.map(r => {
      const url = URL.createObjectURL(r.blob);
      urls.push(url);
      const fname = sceneName + '-' + r.name + '.mp4';
      return '<a class="rec-dl-link" href="' + url + '" download="' + fname + '">'
           + '\u2b07 ' + fname + ' <span class="rec-dl-size">' + fmt(r.blob.size) + '</span></a>';
    }).join('');

    overlayEl.innerHTML =
      '<div class="rec-downloads"><h3>Recording Complete</h3>'
      + links
      + '<button class="rec-close-btn" id="rec-close">Close</button></div>';

    document.getElementById('rec-close').addEventListener('click', () => {
      overlayEl.classList.remove('active');
      overlayEl.innerHTML = '';
      recording = false;
      urls.forEach(u => URL.revokeObjectURL(u));
    });
  }

  // ===== Main recording flow =====
  async function startRecording() {
    if (recording || !window.SCENE) return;
    const S = window.SCENE;
    if (!S.currentBuffer) return;

    recording = true;
    cancelRef = { cancelled: false };
    recordBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
    showProgress();

    try {
      const config = snapshotConfig();
      const audioBuffer = S.currentBuffer;
      const smoothing = S.analyser ? S.analyser.smoothingTimeConstant : 0.85;

      // Step 1: Pre-analyze audio
      setStepState('analyze', 'active');
      await new Promise(r => setTimeout(r, 50));
      const frameData = preAnalyzeAudio(audioBuffer, smoothing, p => setProgress(p * 0.08));
      setStepState('analyze', 'done');
      setProgress(0.08);

      if (cancelRef.cancelled) throw { cancelled: true };

      // Steps 2–4: Record each format
      const results = [];
      for (let fi = 0; fi < FORMATS.length; fi++) {
        if (cancelRef.cancelled) throw { cancelled: true };
        const f = FORMATS[fi];
        setStepState(f.name, 'active');
        const base = 0.08 + fi * 0.307;
        const blob = await recordFormat(config, frameData, f, audioBuffer, p => {
          setProgress(base + p * 0.307);
        });
        if (cancelRef.cancelled || !blob) throw { cancelled: true };
        results.push({ name: f.name, blob });
        setStepState(f.name, 'done');
      }

      showDownloads(results, config.sceneName);
    } catch (err) {
      if (err && err.cancelled) {
        overlayEl.classList.remove('active');
        overlayEl.innerHTML = '';
        recording = false;
        return;
      }
      console.error('Recording failed:', err);
      overlayEl.innerHTML =
        '<div class="rec-downloads"><h3>Recording Failed</h3>'
        + '<p style="color:#ff6666;font-size:13px;margin-bottom:20px">' + (err.message || err) + '</p>'
        + '<button class="rec-close-btn" id="rec-close">Close</button></div>';
      document.getElementById('rec-close').addEventListener('click', () => {
        overlayEl.classList.remove('active');
        overlayEl.innerHTML = '';
        recording = false;
      });
    }
  }

  // ===== Init =====
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
