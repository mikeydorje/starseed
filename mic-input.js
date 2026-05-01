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

  // fs-btn and back-btn don't exist yet (they're after mic-input.js in the DOM),
  // so we resolve them lazily after DOMContentLoaded.
  var fsBtnEl = null;
  var backBtnEl = null;
  var isMobile = matchMedia('(pointer: coarse) and (hover: none)').matches;
  var pseudoFS = false;

  function enterPseudoFS() {
    pseudoFS = true;
    if (fsBtnEl) fsBtnEl.style.display = 'none';
    if (backBtnEl) backBtnEl.style.display = 'none';
    document.body.classList.add('pseudo-fs');
  }

  function exitPseudoFS() {
    if (!pseudoFS) return;
    pseudoFS = false;
    if (fsBtnEl) fsBtnEl.style.display = '';
    if (backBtnEl) backBtnEl.style.display = '';
    document.body.classList.remove('pseudo-fs');
  }

  const style = document.createElement('style');
  var listenRight = isMobile ? 60 : 104;
  style.textContent = [
    '.listen-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px 0;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:rgba(80,180,220,0.85);background:rgba(80,180,220,0.12);border:1px solid rgba(80,180,220,0.25);border-radius:10px;cursor:pointer;transition:all 0.3s;margin-bottom:16px}',
    '.listen-btn:hover{background:rgba(80,180,220,0.25);border-color:rgba(80,180,220,0.4)}',
    '.listen-btn.active{color:rgba(220,100,80,0.9);background:rgba(220,100,80,0.12);border-color:rgba(220,100,80,0.25)}',
    '.listen-btn.active:hover{background:rgba(220,100,80,0.25);border-color:rgba(220,100,80,0.4)}',
    '#controls.visible~#rec-btn,#controls.visible~#rec-pause-btn,#controls.visible~#ctrl-panel,#controls.visible~#popout-transport-btn,#controls.visible~#close-popout-btn{display:none!important}',
    'body.pseudo-fs #rec-btn,body.pseudo-fs #rec-pause-btn,body.pseudo-fs #ctrl-panel,body.pseudo-fs #popout-transport-btn,body.pseudo-fs #close-popout-btn{display:none!important}',
    'body.pseudo-fs canvas{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;transform:none!important;box-shadow:none!important}',
    'body.toolbar-hidden #rec-btn,body.toolbar-hidden #rec-pause-btn,body.toolbar-hidden #fs-btn,body.toolbar-hidden #popout-transport-btn,body.toolbar-hidden #close-popout-btn{transform:translateY(60px);transition:transform 0.3s ease}',
    'body.toolbar-hidden #ctrl-panel{transform:translateX(calc(100% + 32px));opacity:0;transition:transform 0.3s ease,opacity 0.3s ease}',
    '#rec-btn,#rec-pause-btn,#fs-btn,#popout-transport-btn,#close-popout-btn{transition:transform 0.3s ease}',
    '#ctrl-panel{transition:transform 0.3s ease,opacity 0.3s ease}',
    '#listen-pause{position:fixed;bottom:16px;right:' + listenRight + 'px;z-index:20;width:36px;height:36px;padding:0;display:none;align-items:center;justify-content:center;background:rgba(10,10,20,0.5);border:1px solid rgba(255,255,255,0.1);border-radius:8px;cursor:pointer;color:rgba(255,255,255,0.4);font-size:16px;backdrop-filter:blur(6px);transition:all 0.3s}',
    '#listen-pause:hover{color:#fff;background:rgba(80,180,220,0.35);border-color:rgba(80,180,220,0.5)}',
    'body.pseudo-fs #listen-pause,body.toolbar-hidden #listen-pause,#controls.visible~#listen-pause{display:none!important}',
    'body.toolbar-hidden #back-btn{opacity:0;pointer-events:none;transition:opacity 0.3s ease}',
    '#back-btn{transition:opacity 0.3s ease}'
  ].join('\n');
  document.head.appendChild(style);

  const listenBtn = document.createElement('button');
  listenBtn.className = 'listen-btn';
  listenBtn.textContent = 'Listen';
  listenBtn.title = 'React to microphone audio';

  // Insert before the file-input / upload area so it's visible on short mobile screens
  const fileInput = document.getElementById('file-input');
  fileInput.insertAdjacentElement('beforebegin', listenBtn);

  var listenPauseBtn = document.createElement('button');
  listenPauseBtn.id = 'listen-pause';
  listenPauseBtn.innerHTML = '&#x23F8;&#xFE0E;'; // ⏸︎
  listenPauseBtn.title = 'Stop listening';
  document.body.appendChild(listenPauseBtn);

  function showListenPause() { listenPauseBtn.style.display = 'flex'; }
  function hideListenPause() { listenPauseBtn.style.display = 'none'; }

  listenPauseBtn.addEventListener('click', function() {
    stopListening();
  });

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
      showListenPause();

      try { if (window.track) window.track('listen_start'); } catch (_) {}

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

    exitPseudoFS();
    hideListenPause();

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

  // fs-btn/back-btn appear later in the DOM, so bind after DOMContentLoaded.
  // Use capturing phase so this fires BEFORE the inline Fullscreen API handler.

  document.addEventListener('DOMContentLoaded', function() {
    fsBtnEl = document.getElementById('fs-btn');
    backBtnEl = document.getElementById('back-btn');
    if (!fsBtnEl) return;

    fsBtnEl.addEventListener('click', function(e) {
      if (!isMobile) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      enterPseudoFS();
    }, true);

    // ── Auto-hide transport system ──
    var transportVisible = false;
    var autoHideTimer = null;
    var AUTO_HIDE_DELAY = 3000;

    function showTransport(delay) {
      var st = S.playState;
      if (st !== 'playing' && st !== 'paused' && st !== 'listening') return;
      if (controlsEl.classList.contains('visible')) return;
      transportVisible = true;
      document.body.classList.remove('toolbar-hidden');
      if (autoHideTimer) clearTimeout(autoHideTimer);
      autoHideTimer = setTimeout(hideTransport, delay || AUTO_HIDE_DELAY);
    }

    function hideTransport() {
      if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
      transportVisible = false;
      document.body.classList.add('toolbar-hidden');
    }

    // Expose for recorder.js to call
    S._showTransport = showTransport;
    S._hideTransport = hideTransport;
    S._holdTransport = function() {
      var st = S.playState;
      if (st !== 'playing' && st !== 'paused' && st !== 'listening') return;
      if (controlsEl.classList.contains('visible')) return;
      transportVisible = true;
      document.body.classList.remove('toolbar-hidden');
      if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
    };
    S._isTransportVisible = function() { return transportVisible; };

    // Desktop: mouse movement shows transport, resets auto-hide timer
    if (!isMobile) {
      var mouseMoveThrottle = 0;
      document.addEventListener('mousemove', function() {
        var now = Date.now();
        if (now - mouseMoveThrottle < 200) return;
        mouseMoveThrottle = now;
        var st = S.playState;
        if (st === 'playing' || st === 'listening') showTransport();
      });
    }

    // Desktop: hide chrome when entering native fullscreen, restore on exit
    var inDesktopFS = false;

    document.addEventListener('fullscreenchange', function() {
      if (isMobile) return;
      if (document.fullscreenElement) {
        inDesktopFS = true;
        hideTransport();
      } else {
        inDesktopFS = false;
        fsBtnEl.style.display = '';
        if (backBtnEl) backBtnEl.style.display = '';
        document.body.classList.remove('toolbar-hidden');
        transportVisible = false;
        if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
      }
    });

    // When #controls overlay becomes visible (pause), stop auto-hide
    var controlsObserver = new MutationObserver(function() {
      if (controlsEl.classList.contains('visible')) {
        transportVisible = false;
        if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
      }
    });
    controlsObserver.observe(controlsEl, { attributes: true, attributeFilter: ['class'] });

    // Spacebar handler (desktop)
    if (!isMobile) {
      document.addEventListener('keydown', function(e) {
        if (e.code !== 'Space') return;
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        var st = S.playState;
        if (st === 'playing') {
          if (!transportVisible) {
            showTransport();
          } else {
            // Transport visible — trigger pause via canvas click path
            S.renderer.domElement.click();
          }
        } else if (st === 'paused') {
          // Resume
          var pb = document.getElementById('play-btn');
          if (pb) pb.click();
        }
      });
    }
  });

  // Canvas click: capturing-phase intercept for auto-hide transport
  // When transport is hidden during playback, show it instead of pausing
  S.renderer.domElement.addEventListener('click', function(e) {
    // Mobile pseudo-FS: exit on tap
    if (pseudoFS) { exitPseudoFS(); return; }
    // During playback or listening: intercept to show transport if hidden
    if (S.playState === 'playing' || S.playState === 'listening') {
      if (!S._isTransportVisible || !S._isTransportVisible()) {
        // Transport hidden — show it, block the scene's pause/stop handler
        if (S._showTransport) S._showTransport();
        e.stopImmediatePropagation();
        return;
      }
      // Transport visible — let through
      // In listen mode: stop listening
      if (S.playState === 'listening') { stopListening(); return; }
      // In playing mode: scene handler will pause
    }
  }, true); // capturing phase — fires before scene's bubble-phase handler

  // Expose stop function for scene integration
  S._stopMic = stopListening;
})();
