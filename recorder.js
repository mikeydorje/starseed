// recorder.js — Offline video recorder for audio-vis scenes
// Records Three.js particle visualizations to MP4 via WebCodecs + mp4-muxer
// Outputs 3 aspect ratios: 16:9, 1:1, 9:16 — all at 1080p, 60fps, maximum quality

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
  let zoomLock = 0;

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
      adjustedFov(config.cameraFov, width / height, zoomLock), width / height, config.cameraNear, config.cameraFar
    );
    camera.position.copy(config.cameraPos);
    camera.quaternion.copy(config.cameraQuat);

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

  // ===== Check if AAC audio encoding is supported =====
  async function isAudioEncoderSupported(buffer) {
    try {
      const probe = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: buffer.sampleRate,
        numberOfChannels: buffer.numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
      return probe.supported;
    } catch (e) {
      return false;
    }
  }

  // ===== Encode original audio into muxer =====
  // Returns true if audio was encoded, false if skipped/failed.
  async function encodeAudio(buffer, muxer) {
    // Validate codec support before attempting encode
    const supported = await isAudioEncoderSupported(buffer);
    if (!supported) {
      console.warn('AudioEncoder: mp4a.40.2 not supported on this browser — video will have no audio');
      return false;
    }

    let encodeError = null;
    const encoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encodeError = e; console.error('AudioEncoder:', e); },
    });
    encoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: buffer.sampleRate,
      numberOfChannels: buffer.numberOfChannels,
      bitrate: AUDIO_BITRATE,
    });

    const CHUNK = 1024;
    // Try f32-planar first; fall back to f32 (interleaved) if the browser rejects it
    let usePlanar = true;
    try {
      const testSize = Math.min(CHUNK, buffer.length);
      const testBuf = new Float32Array(testSize * buffer.numberOfChannels);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        testBuf.set(buffer.getChannelData(ch).subarray(0, testSize), ch * testSize);
      }
      const testData = new AudioData({
        format: 'f32-planar',
        sampleRate: buffer.sampleRate,
        numberOfFrames: testSize,
        numberOfChannels: buffer.numberOfChannels,
        timestamp: 0,
        data: testBuf,
      });
      testData.close();
    } catch (e) {
      usePlanar = false;
    }

    for (let offset = 0; offset < buffer.length; offset += CHUNK) {
      if (encodeError) break;
      const size = Math.min(CHUNK, buffer.length - offset);
      let dataBuf, fmt;
      if (usePlanar) {
        dataBuf = new Float32Array(size * buffer.numberOfChannels);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          dataBuf.set(buffer.getChannelData(ch).subarray(offset, offset + size), ch * size);
        }
        fmt = 'f32-planar';
      } else {
        dataBuf = new Float32Array(size * buffer.numberOfChannels);
        for (let s = 0; s < size; s++) {
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            dataBuf[s * buffer.numberOfChannels + ch] = buffer.getChannelData(ch)[offset + s];
          }
        }
        fmt = 'f32';
      }
      const audioData = new AudioData({
        format: fmt,
        sampleRate: buffer.sampleRate,
        numberOfFrames: size,
        numberOfChannels: buffer.numberOfChannels,
        timestamp: Math.round(offset / buffer.sampleRate * 1_000_000),
        data: dataBuf,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
    encoder.close();

    if (encodeError) {
      console.warn('AudioEncoder failed during encode — video will have no audio');
      return false;
    }
    return true;
  }

  // ===== Record one aspect ratio → MP4 Blob =====
  async function recordFormat(config, frameData, fmt, audioBuffer, onProgress, fps) {
    fps = fps || FPS;
    const { Muxer, ArrayBufferTarget } = await getMuxerModule();
    const { width, height } = fmt;
    const totalFrames = frameData.length;

    // Pre-check audio support so we can configure the muxer correctly
    const audioSupported = await isAudioEncoderSupported(audioBuffer);

    const target = new ArrayBufferTarget();
    const muxerOpts = {
      target,
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory',
    };
    if (audioSupported) {
      muxerOpts.audio = {
        codec: 'aac',
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
      };
    }
    const muxer = new Muxer(muxerOpts);

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

    // Encode & mux audio (if supported)
    let hasAudio = false;
    if (audioSupported) {
      hasAudio = await encodeAudio(audioBuffer, muxer);
    }

    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    blob._hasAudio = hasAudio;

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
    };
  }

  // ===== Per-format render state =====
  let renderQueue = [];
  let processing = false;
  let cachedFrameData = null;
  let cachedConfig = null;
  let cachedAudioBuffer = null;
  let cachedSmoothing = 0.85;
  let blobUrls = [];
  let formatStates = {}; // keyed by format name

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
        position:fixed; bottom:16px; right:60px; z-index:20;
        font-family:'Segoe UI',sans-serif; font-size:10px; color:#555;
      }
      #fmt-preview-bar {
        position:fixed; bottom:16px; right:148px; z-index:20;
        display:none; gap:4px; align-items:center;
      }
      .fmt-prev-btn {
        height:36px; padding:0 8px; display:inline-flex; align-items:center; justify-content:center;
        font-family:'Segoe UI',sans-serif; font-size:10px;
        letter-spacing:0.5px; color:rgba(255,255,255,0.3);
        background:rgba(10,10,20,0.5); border:1px solid rgba(255,255,255,0.08);
        border-radius:6px; cursor:pointer; transition:all 0.3s;
        backdrop-filter:blur(6px); line-height:1; box-sizing:border-box;
      }
      .fmt-prev-btn:hover { color:rgba(255,255,255,0.6); border-color:rgba(255,255,255,0.15); }
      .fmt-prev-btn.active { color:#b8b0e8; border-color:rgba(123,111,219,0.4); background:rgba(123,111,219,0.15); }
      #zoom-lock-toggle {
        height:36px; padding:0 8px; display:inline-flex; align-items:center; justify-content:center;
        font-family:'Segoe UI',sans-serif; font-size:10px;
        letter-spacing:0.5px; color:rgba(255,255,255,0.25);
        background:rgba(10,10,20,0.5); border:1px solid rgba(255,255,255,0.06);
        border-radius:6px; cursor:pointer; transition:all 0.3s;
        backdrop-filter:blur(6px); line-height:1; box-sizing:border-box;
        margin-left:2px;
      }
      #zoom-lock-toggle:hover { color:rgba(255,255,255,0.5); border-color:rgba(255,255,255,0.12); }
      #zoom-lock-toggle.active { color:#e8c080; border-color:rgba(219,175,111,0.4); background:rgba(219,175,111,0.12); }
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

  // ===== UI: Create elements =====
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

    // Format preview toggle buttons
    const previewBar = document.createElement('div');
    previewBar.id = 'fmt-preview-bar';
    FORMATS.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'fmt-prev-btn';
      btn.textContent = f.label;
      btn.dataset.fmt = f.name;
      btn.title = f.width + '\u00d7' + f.height + ' preview';
      btn.addEventListener('click', () => togglePreview(f));
      previewBar.appendChild(btn);
    });
    // Aperture Scale toggle — reframes composition across aspect ratios
    const zlBtn = document.createElement('button');
    zlBtn.id = 'zoom-lock-toggle';
    zlBtn.textContent = '\u25cd Aperture Scale';
    zlBtn.title = 'Experimental composition scaling across all aspect ratios';
    zlBtn.addEventListener('click', () => {
      zoomLock = zoomLock ? 0 : 1;
      zlBtn.classList.toggle('active', !!zoomLock);
      if (activePreviewFmt) activatePreview(activePreviewFmt);
    });
    previewBar.appendChild(zlBtn);
    document.body.appendChild(previewBar);

    // Watch for slider changes — mark params dirty so rec hides until next play
    document.querySelectorAll('#controls input[type="range"]').forEach(el => {
      el.addEventListener('input', () => {
        if (!recording) paramsDirty = true;
      });
    });

    // Poll playState to show/hide record + pause + preview buttons
    setInterval(() => {
      if (!window.SCENE || recording) return;
      const st = window.SCENE.playState;

      // Transition to 'playing' clears dirty flag (user hit Play with new params)
      if (st === 'playing' && lastPlayState !== 'playing') {
        paramsDirty = false;
        // Re-activate preview after resize-triggered pause so it reconfigures for new window size
        if (activePreviewFmt && _resizedDuringPreview) {
          _resizedDuringPreview = false;
          activatePreview(activePreviewFmt);
        } else if (!activePreviewFmt) {
          // Default to 16:9 preview on playback start
          activatePreview(FORMATS[0]);
        }
      }
      lastPlayState = st;

      const showControls = (st === 'playing' || st === 'paused') && !paramsDirty;
      recordBtn.style.display = showControls ? 'flex' : 'none';
      pauseBtn.style.display = showControls ? 'flex' : 'none';
      previewBar.style.display = showControls ? 'flex' : 'none';
      pauseBtn.innerHTML = st === 'paused' ? '\u25b6\uFE0E' : '\u2759\u2759';
      pauseBtn.title = st === 'paused' ? 'Resume' : 'Pause';

      // Clear preview if controls hidden or playback stops
      if (!showControls && activePreviewFmt) deactivatePreview();
    }, 200);
  }

  // ===== Pause / Resume =====
  function togglePause() {
    if (!window.SCENE) return;
    const S = window.SCENE;
    const st = S.playState;
    if (st === 'playing' && S.audioContext) {
      S.audioContext.suspend();
      document.querySelector('canvas').click();
    } else if (st === 'paused') {
      const playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.click();
    }
  }

  // ===== Format preview =====
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

    document.querySelectorAll('.fmt-prev-btn').forEach(b => {
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

    document.querySelectorAll('.fmt-prev-btn').forEach(b => b.classList.remove('active'));
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
    // Save active preview so we can restore it on close/cancel
    _savedPreviewFmt = activePreviewFmt;
    _savedBaseFov = _baseFov;
    if (activePreviewFmt) deactivatePreview();
    recording = true;
    cancelRef = { cancelled: false };
    recordBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
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
    `;

    // Bind render buttons
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
      // Cancel: stop current render, clear queue
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
      const noAudio = st.blob && st.blob._hasAudio === false ? ' (no audio)' : '';
      status.textContent = (sz > 1048576 ? (sz / 1048576).toFixed(1) + ' MB' : (sz / 1024).toFixed(0) + ' KB') + noAudio;
      status.style.color = noAudio ? 'rgba(200,180,80,0.7)' : 'rgba(80,200,80,0.7)';
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
      const sceneName = window.SCENE ? (window.SCENE.sceneName || 'scene') : 'scene';
      dl.href = st.url;
      dl.download = sceneName + '-' + name + '.mp4';
      dl.textContent = '\u2b07 Download';
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

  // ===== Queue & process =====
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
      // Pre-analyze once (lazy, before first render)
      if (!cachedFrameData) {
        const S = window.SCENE;
        if (!S || !S.currentBuffer) { processing = false; return; }
        cachedConfig = snapshotConfig();
        cachedAudioBuffer = S.currentBuffer;
        cachedSmoothing = S.analyser ? S.analyser.smoothingTimeConstant : 0.85;

        setAnalyzeStatus('Pre-analyzing audio\u2026', true);
        await new Promise(r => setTimeout(r, 50));
        cachedFrameData = preAnalyzeAudio(cachedAudioBuffer, cachedSmoothing);
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
