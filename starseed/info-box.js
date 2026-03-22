// --- Info Box: appears once on play, dismissable, "don't show again" persists ---
(function () {
  const STORAGE_KEY = 'starseed-info-dismissed';
  if (localStorage.getItem(STORAGE_KEY) === '1') return;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #info-box{position:fixed;top:48px;left:16px;z-index:25;max-width:300px;padding:16px 18px 14px;
      background:rgba(10,10,18,0.72);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);
      border-radius:12px;font-family:'Segoe UI',system-ui,sans-serif;color:rgba(255,255,255,0.7);
      font-size:12px;line-height:1.55;opacity:0;pointer-events:none;
      transform:translateY(-6px);transition:opacity 0.5s ease,transform 0.5s ease}
    #info-box.visible{opacity:1;pointer-events:auto;transform:translateY(0)}
    #info-box.fade-out{opacity:0;pointer-events:none;transition:opacity 1.2s ease}
    #info-box p{margin:0 0 10px}
    #info-box .ib-close{position:absolute;top:8px;right:10px;background:none;border:none;
      color:rgba(255,255,255,0.35);font-size:16px;cursor:pointer;padding:2px 6px;line-height:1;transition:color 0.2s}
    #info-box .ib-close:hover{color:rgba(255,255,255,0.8)}
    #info-box .ib-dismiss{display:inline;font-size:10px;color:rgba(255,255,255,0.25);cursor:pointer;
      background:none;border:none;padding:0;font-family:inherit;transition:color 0.2s;margin-top:4px}
    #info-box .ib-dismiss:hover{color:rgba(255,255,255,0.5)}
    @media(max-width:400px){#info-box{max-width:calc(100vw - 32px);left:8px;top:44px;font-size:11px;padding:12px 14px 10px}}
  `;
  document.head.appendChild(style);

  // Build DOM
  const box = document.createElement('div');
  box.id = 'info-box';
  box.innerHTML = `
    <button class="ib-close" title="Close">&times;</button>
    <p>Hit <strong>⏺︎ Record</strong> to capture video in <strong>16:9</strong>, <strong>1:1</strong>, or <strong>9:16</strong>. The visuals adapt to each format — every ratio has its own character. <strong>Aperture Scale</strong> adjusts the field of view — use it to reframe the composition for each format.</p>
    <p>While rendering, keep this tab in the foreground and your device awake — the browser needs the screen active to draw each frame.</p>
    <p><strong>iOS:</strong> rendered videos won't include audio yet (working on it). Screen-record or sync audio later — or come back on desktop.</p>
    <p>Drift cycles mean no two captures are ever quite the same.</p>
    <p><strong>Listen mode</strong> reacts to your mic in real time at your browser's native size and resolution. No record button here (use screen record).</p>
    <button class="ib-dismiss">don't show this again</button>
  `;
  document.body.appendChild(box);

  function show() {
    if (localStorage.getItem(STORAGE_KEY) === '1') return;
    box.classList.remove('fade-out');
    box.classList.add('visible');
  }

  function close() {
    box.classList.add('fade-out');
    box.classList.remove('visible');
    // If playback was deferred and we're not in listen mode, trigger it now
    if (pendingPlay && (!window.SCENE || window.SCENE.playState !== 'listening')) {
      pendingPlay = false;
      bypassGate = true;
      playBtn.click();
    } else {
      pendingPlay = false;
    }
  }

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    close();
  }

  box.querySelector('.ib-close').addEventListener('click', close);
  box.querySelector('.ib-dismiss').addEventListener('click', dismiss);

  // Gate playback behind info box dismissal
  const playBtn = document.getElementById('play-btn');
  let pendingPlay = false;
  let bypassGate = false;

  if (playBtn) {
    // Capturing listener fires before the scene's handler
    playBtn.addEventListener('click', function (e) {
      if (bypassGate) { bypassGate = false; return; }
      if (localStorage.getItem(STORAGE_KEY) === '1') return;
      // Resume should never trigger info box — just play
      if (playBtn.textContent.indexOf('Resume') !== -1) return;
      // If info box is already open, treat play as dismiss
      if (box.classList.contains('visible')) { e.stopImmediatePropagation(); close(); return; }
      // Block playback and show info box instead
      e.stopImmediatePropagation();
      pendingPlay = true;
      show();
    }, true);
  }
})();
