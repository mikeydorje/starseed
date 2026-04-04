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
  style.textContent = [
    '.listen-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px 0;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:rgba(80,180,220,0.85);background:rgba(80,180,220,0.12);border:1px solid rgba(80,180,220,0.25);border-radius:10px;cursor:pointer;transition:all 0.3s;margin-bottom:16px}',
    '.listen-btn:hover{background:rgba(80,180,220,0.25);border-color:rgba(80,180,220,0.4)}',
    '.listen-btn.active{color:rgba(220,100,80,0.9);background:rgba(220,100,80,0.12);border-color:rgba(220,100,80,0.25)}',
    '.listen-btn.active:hover{background:rgba(220,100,80,0.25);border-color:rgba(220,100,80,0.4)}',
    '#controls.visible~#rec-btn,#controls.visible~#rec-pause-btn,#controls.visible~#ctrl-panel{display:none!important}',
    'body.pseudo-fs #rec-btn,body.pseudo-fs #rec-pause-btn,body.pseudo-fs #ctrl-panel,body.pseudo-fs #toolbar-tab{display:none!important}',
    'body.pseudo-fs canvas{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;transform:none!important;box-shadow:none!important}',
    'body.toolbar-hidden #rec-btn,body.toolbar-hidden #rec-pause-btn{transform:translateY(60px);transition:transform 0.3s ease}',
    'body.toolbar-hidden #ctrl-panel{transform:translateX(calc(100% + 32px));opacity:0;transition:transform 0.3s ease,opacity 0.3s ease}',
    '#rec-btn,#rec-pause-btn{transition:transform 0.3s ease}',
    '#ctrl-panel{transition:transform 0.3s ease,opacity 0.3s ease}',
    '#toolbar-tab{position:fixed;bottom:16px;right:104px;z-index:21;width:36px;height:36px;display:none;align-items:center;justify-content:center;background:rgba(10,10,20,0.5);border:1px solid rgba(255,255,255,0.08);border-radius:8px;cursor:pointer;color:rgba(255,255,255,0.3);font-size:12px;backdrop-filter:blur(6px);transition:color 0.3s,transform 0.3s ease}',
    '#toolbar-tab:hover{color:rgba(255,255,255,0.6)}',
    '#listen-pause{position:fixed;bottom:16px;right:60px;z-index:20;width:36px;height:36px;padding:0;display:none;align-items:center;justify-content:center;background:rgba(10,10,20,0.5);border:1px solid rgba(255,255,255,0.1);border-radius:8px;cursor:pointer;color:rgba(255,255,255,0.4);font-size:16px;backdrop-filter:blur(6px);transition:all 0.3s}',
    '#listen-pause:hover{color:#fff;background:rgba(80,180,220,0.35);border-color:rgba(80,180,220,0.5)}',
    'body.pseudo-fs #listen-pause,body.toolbar-hidden #listen-pause,#controls.visible~#listen-pause{display:none!important}'
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
  var desktopFSHidden = false;

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

    var toolbarTab = document.createElement('button');
    toolbarTab.id = 'toolbar-tab';
    toolbarTab.innerHTML = '\u25B2';  // ▲
    toolbarTab.title = 'Show toolbar';
    document.body.appendChild(toolbarTab);

    toolbarTab.addEventListener('click', function() {
      var hidden = document.body.classList.toggle('toolbar-hidden');
      toolbarTab.classList.toggle('open', !hidden);
      toolbarTab.innerHTML = hidden ? '\u25B2' : '\u25BC';
      toolbarTab.title = hidden ? 'Show toolbar' : 'Hide toolbar';
    });

    // Desktop: hide chrome when entering native fullscreen, restore on exit
    var inDesktopFS = false;
    var tabWasVisible = false;

    function updateTabVisibility() {
      var st = S.playState;
      var toolbarWouldShow = (st === 'playing' || st === 'paused' || st === 'listening') && !controlsEl.classList.contains('visible');
      toolbarTab.style.display = toolbarWouldShow ? 'flex' : 'none';
      // On transition to showing in fullscreen: auto-hide toolbar, reset tab to ▲
      if (toolbarWouldShow && !tabWasVisible && inDesktopFS) {
        document.body.classList.add('toolbar-hidden');
        toolbarTab.classList.remove('open');
        toolbarTab.innerHTML = '\u25B2';
        toolbarTab.title = 'Show toolbar';
      }
      tabWasVisible = toolbarWouldShow;
    }

    document.addEventListener('fullscreenchange', function() {
      if (isMobile) return;
      if (document.fullscreenElement) {
        desktopFSHidden = true;
        inDesktopFS = true;
        fsBtnEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'none';
        document.body.classList.add('toolbar-hidden');
        toolbarTab.classList.remove('open');
        toolbarTab.innerHTML = '\u25B2';
        updateTabVisibility();
      } else {
        desktopFSHidden = false;
        inDesktopFS = false;
        fsBtnEl.style.display = '';
        if (backBtnEl) backBtnEl.style.display = '';
        document.body.classList.remove('toolbar-hidden');
        toolbarTab.classList.remove('open');
        updateTabVisibility();
      }
    });

    // Sync tab visibility with toolbar state (recorder polls at 200ms too)
    setInterval(updateTabVisibility, 250);
  });

  // Canvas click: restore chrome in fullscreen/pseudo-fs OR toggle controls during mic mode
  S.renderer.domElement.addEventListener('click', () => {
    if (pseudoFS) { exitPseudoFS(); return; }
    if (desktopFSHidden) {
      desktopFSHidden = false;
      if (fsBtnEl) fsBtnEl.style.display = '';
      if (backBtnEl) backBtnEl.style.display = '';
      return;
    }
    if (S.playState !== 'listening') return;
    stopListening();
  });

  // Expose stop function for scene integration
  S._stopMic = stopListening;
})();
