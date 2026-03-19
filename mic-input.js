// mic-input.js — Live microphone input for audio-vis scenes
// Connects device mic to the scene's AnalyserNode via getUserMedia
// Interacts entirely through window.SCENE

(function() {
  'use strict';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  const S = window.SCENE;
  if (!S) return;

  const controlsEl = document.getElementById('controls');
  const playBtn = document.getElementById('play-btn');
  const audioReady = document.getElementById('audio-ready');

  let micStream = null;
  let micSource = null;

  // --- Inject styles ---
  const style = document.createElement('style');
  style.textContent = [
    '.listen-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px 0;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:rgba(80,180,220,0.85);background:rgba(80,180,220,0.12);border:1px solid rgba(80,180,220,0.25);border-radius:10px;cursor:pointer;transition:all 0.3s;margin-bottom:16px}',
    '.listen-btn:hover{background:rgba(80,180,220,0.25);border-color:rgba(80,180,220,0.4)}',
    '.listen-btn.active{color:rgba(220,100,80,0.9);background:rgba(220,100,80,0.12);border-color:rgba(220,100,80,0.25)}',
    '.listen-btn.active:hover{background:rgba(220,100,80,0.25);border-color:rgba(220,100,80,0.4)}',
    '.controls-inner{padding-bottom:80px}',
    '@media(max-width:600px){#fs-btn{display:none!important}#back-btn{right:auto;left:50%;transform:translateX(-50%)}}'
  ].join('\n');
  document.head.appendChild(style);

  // --- Create button ---
  const listenBtn = document.createElement('button');
  listenBtn.className = 'listen-btn';
  listenBtn.textContent = 'Listen';
  listenBtn.title = 'React to microphone audio';

  // Insert before the file-input / upload area so it's visible on short mobile screens
  const fileInput = document.getElementById('file-input');
  fileInput.insertAdjacentElement('beforebegin', listenBtn);

  // --- Mic activation ---
  async function startListening() {
    try {
      const { audioContext, analyser } = S.ensureAudio();

      S.stopFileAudio();
      S.applyAndLaunch();

      // Disconnect analyser from speakers to prevent mic feedback
      try { analyser.disconnect(); } catch(e) {}

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(analyser);

      // iOS Safari requires resume inside user gesture
      if (audioContext.state === 'suspended') await audioContext.resume();

      S.setPlayState('listening');
      listenBtn.textContent = 'Stop Listening';
      listenBtn.classList.add('active');
    } catch (err) {
      console.warn('Mic access denied:', err.message);
      stopListening();
    }
  }

  function stopListening() {
    if (micSource) {
      try { micSource.disconnect(); } catch(e) {}
      micSource = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    S.setPlayState('idle');
    listenBtn.textContent = 'Listen';
    listenBtn.classList.remove('active');

    controlsEl.classList.remove('hidden');
    controlsEl.classList.add('visible');

    if (playBtn) playBtn.textContent = '\u25b6\uFE0E Play';
  }

  listenBtn.addEventListener('click', () => {
    if (S.playState === 'listening') {
      stopListening();
    } else {
      startListening();
    }
  });

  // Canvas click: toggle controls visibility during mic mode
  S.renderer.domElement.addEventListener('click', () => {
    if (S.playState !== 'listening') return;
    controlsEl.classList.toggle('visible');
    controlsEl.classList.toggle('hidden');
  });

  // Expose stop function for scene integration
  S._stopMic = stopListening;
})();
