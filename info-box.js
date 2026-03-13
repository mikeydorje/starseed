// --- Info Box: appears once on play, dismissable, "don't show again" persists ---
(function () {
  const STORAGE_KEY = 'audio-vis-info-dismissed';
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
    #info-box .ib-footer{display:flex;align-items:center;gap:6px;margin-top:6px}
    #info-box .ib-footer label{font-size:10px;color:rgba(255,255,255,0.35);cursor:pointer;display:flex;align-items:center;gap:5px}
    #info-box .ib-footer input[type=checkbox]{accent-color:rgba(255,255,255,0.3);width:12px;height:12px;cursor:pointer}
    @media(max-width:400px){#info-box{max-width:calc(100vw - 32px);left:8px;top:44px;font-size:11px;padding:12px 14px 10px}}
  `;
  document.head.appendChild(style);

  // Build DOM
  const box = document.createElement('div');
  box.id = 'info-box';
  box.innerHTML = `
    <button class="ib-close" title="Close">&times;</button>
    <p>Hit <strong>⏺ Record</strong> to render video in <strong>16:9</strong>, <strong>1:1</strong>, or <strong>9:16</strong>. The visuals are boundary-aware — they adapt to any aspect ratio and screen size, so each format has its own character. Try resizing your browser to see.</p>
    <p>Each render also varies slightly due to background drift cycles, so no two captures are exactly the same — even with identical settings.</p>
    <div class="ib-footer"><label><input type="checkbox" id="ib-dismiss"/>Don't show again</label></div>
  `;
  document.body.appendChild(box);

  let fadeTimer = null;

  function show() {
    if (localStorage.getItem(STORAGE_KEY) === '1') return;
    box.classList.remove('fade-out');
    box.classList.add('visible');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(close, 30000);
  }

  function close() {
    clearTimeout(fadeTimer);
    box.classList.add('fade-out');
    box.classList.remove('visible');
    if (document.getElementById('ib-dismiss').checked) {
      localStorage.setItem(STORAGE_KEY, '1');
    }
  }

  box.querySelector('.ib-close').addEventListener('click', close);

  // Hook into play button
  const playBtn = document.getElementById('play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', function () {
      // Small delay so it appears after controls fade
      setTimeout(show, 600);
    });
  }
})();
