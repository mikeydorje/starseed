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
    '#listen-pause{position:fixed;bottom:16px;right:' + listenRight + 'px;z-index:20;width:36px;height:36px;padding:0;display:none;align-items:center;justify-content:center;background:rgba(10,10,20,0.5);border:1px solid rgba(255,255,255,0.1);border-radius:8px;cursor:pointer;color:rgba(255,255,255,0.4);font-size:16px;backdrop-filter:blur(6px);transition:all 0.3s}',
    '#listen-pause:hover{color:#fff;background:rgba(80,180,220,0.35);border-color:rgba(80,180,220,0.5)}',
    'body.pseudo-fs #listen-pause,#controls.visible~#listen-pause{display:none!important}',
    /* Chrome collapse: click canvas during playback to hide all chrome; click again to show. */
    '#fs-btn,#back-btn,#ctrl-panel,#rec-btn,#rec-pause-btn,#popout-transport-btn,#close-popout-btn,#listen-pause{transition:opacity 0.3s ease}',
    'body.chrome-collapsed #fs-btn,body.chrome-collapsed #back-btn,body.chrome-collapsed #ctrl-panel,body.chrome-collapsed #rec-btn,body.chrome-collapsed #rec-pause-btn,body.chrome-collapsed #popout-transport-btn,body.chrome-collapsed #close-popout-btn,body.chrome-collapsed #listen-pause{opacity:0!important;pointer-events:none!important}'
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

  // ── Chrome collapse + auto-hide ──
  var AUTO_HIDE_DELAY = 7000;
  var autoHideTimer = null;
  // Selector for elements that should NOT trigger toggle when clicked.
  var CHROME_SELECTOR = '#controls, #fs-btn, #back-btn, #ctrl-panel, #rec-btn, #rec-pause-btn, #popout-transport-btn, #close-popout-btn, #listen-pause, #info-box, #info-toggle';

  function setChromeCollapsed(collapsed) {
    var was = isChromeCollapsed();
    document.body.classList.toggle('chrome-collapsed', !!collapsed);
    if (collapsed) {
      cancelAutoHide();
    } else if (!was) {
      // Was already visible — just bump the timer.
      armAutoHide();
    } else {
      armAutoHide();
    }
  }
  function isChromeCollapsed() {
    return document.body.classList.contains('chrome-collapsed');
  }
  function armAutoHide() {
    cancelAutoHide();
    var st = S.playState;
    if (st !== 'playing' && st !== 'listening') return;
    if (controlsEl.classList.contains('visible')) return;
    if (isChromeCollapsed()) return;
    autoHideTimer = setTimeout(function() {
      autoHideTimer = null;
      // Re-check state; don't hide if user paused or chrome was already collapsed.
      var s = S.playState;
      if (s !== 'playing' && s !== 'listening') return;
      if (controlsEl.classList.contains('visible')) return;
      document.body.classList.add('chrome-collapsed');
    }, AUTO_HIDE_DELAY);
  }
  function cancelAutoHide() {
    if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
  }
  // Any user activity over chrome resets the timer.
  function bumpAutoHide() {
    if (isChromeCollapsed()) return;
    if (autoHideTimer) armAutoHide();
  }
  ['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'input'].forEach(function(evt) {
    document.addEventListener(evt, bumpAutoHide, true);
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

    // Compatibility shims for recorder.js — the old auto-hide system is gone.
    // Treat "transport visible" as "chrome not collapsed".
    S._showTransport = function() { setChromeCollapsed(false); };
    S._hideTransport = function() { setChromeCollapsed(true); };
    S._holdTransport = function() { setChromeCollapsed(false); };
    S._isTransportVisible = function() { return !isChromeCollapsed(); };

    // Restore expanded chrome on FS exit so the user lands on full UI.
    document.addEventListener('fullscreenchange', function() {
      if (isMobile) return;
      if (!document.fullscreenElement) {
        fsBtnEl.style.display = '';
        if (backBtnEl) backBtnEl.style.display = '';
        setChromeCollapsed(false);
      }
    });

    // When #controls overlay becomes visible (pause), make sure chrome isn't collapsed
    // so the pause UI is reachable.
    var controlsObserver = new MutationObserver(function() {
      if (controlsEl.classList.contains('visible')) setChromeCollapsed(false);
    });
    controlsObserver.observe(controlsEl, { attributes: true, attributeFilter: ['class'] });

    // Spacebar handler (desktop): pause/resume directly.
    if (!isMobile) {
      document.addEventListener('keydown', function(e) {
        if (e.code !== 'Space') return;
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        var st = S.playState;
        if (st === 'playing') {
          // Trigger pause via canvas click path (synthetic — bypasses chrome-toggle intercept)
          S.renderer.domElement.click();
        } else if (st === 'paused') {
          var pb = document.getElementById('play-btn');
          if (pb) pb.click();
        }
      });
    }
  });

  // Document-level click intercept (capture phase).
  // During playback/listening, real user clicks anywhere outside #controls / chrome elements
  // toggle chrome visibility (canvas, page margins, letterbox bars, body, etc.).
  // Pause is a separate button. Synthetic clicks (e.isTrusted=false) from togglePause()
  // / spacebar pass through to the scene's pause handler.
  document.addEventListener('click', function(e) {
    // Mobile pseudo-FS: tap canvas to exit
    if (pseudoFS && e.target === S.renderer.domElement) { exitPseudoFS(); return; }
    if (!e.isTrusted) return;
    var st = S.playState;
    if (st !== 'playing' && st !== 'listening') return;
    // Ignore clicks on any chrome element — buttons should do their own thing.
    if (e.target.closest && e.target.closest(CHROME_SELECTOR)) return;
    setChromeCollapsed(!isChromeCollapsed());
    e.stopImmediatePropagation();
  }, true);

  // Arm the auto-hide whenever playback transitions into an active state.
  var lastWatchedState = null;
  setInterval(function() {
    var st = S.playState;
    if (st !== lastWatchedState) {
      lastWatchedState = st;
      if (st === 'playing' || st === 'listening') {
        if (!isChromeCollapsed()) armAutoHide();
      } else {
        cancelAutoHide();
      }
    }
  }, 250);

  // Expose stop function for scene integration
  S._stopMic = stopListening;
})();
