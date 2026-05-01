// Starseed anonymous usage tracker — client.
//
// Public API:
//   window.track(event, props?)        // fire-and-forget, never throws
//
// Auto-fires on load:
//   - 'pageview' on index.html
//   - 'scene_open' { scene } on any of the 18 scene pages
//
// Skipped on localhost / 127.0.0.1 unless the URL contains ?track=1.
// No cookies, no localStorage, no fingerprinting. The Worker hashes IP+UA
// in memory only and stores an opaque, daily-rotating dedupe hash.

(function () {
  'use strict';

  // Deployed Cloudflare Worker. Update ALLOWED_ORIGINS in the worker's
  // wrangler.toml (not here) when the production domain changes.
  var ENDPOINT = 'https://starseed-tracker.mikey-4cf.workers.dev/e';

  var ALLOWED_EVENTS = {
    pageview: 1,
    scene_open: 1,
    listen_start: 1,
    record_click: 1,
    record_terms_accept: 1,
    render_complete: 1,
  };

  // Slugs that match the file basenames of the scene HTMLs at the site root.
  var SCENE_SLUGS = {
    'smbh': 1, 'binary-smbh': 1,
    'lotus': 1, 'ember': 1, 'filament': 1, 'spore': 1, 'lattice': 1,
    'pi': 1, 'tau': 1, 'phi': 1, 'euler': 1, 'feigenbaum': 1, 'mathematical-pony': 1,
    'only-shallow': 1, 'to-here-knows-when': 1, 'i-only-said': 1,
    'sometimes': 1, 'blown-a-wish': 1, 'sakura': 1,
    'spectrum': 1, 'wip': 1,
  };

  function isLocal() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '';
  }

  var FORCE = /[?&]track=1\b/.test(location.search);
  var ENABLED = FORCE || !isLocal();

  // Derive scene slug from URL: /lotus.html → 'lotus'. Returns null for
  // index.html or anything not in the allow-list.
  function deriveScene() {
    var path = location.pathname || '';
    var m = path.match(/([^/]+)\.html?$/i);
    if (!m) return null;
    var slug = m[1].toLowerCase();
    if (slug === 'index') return null;
    return SCENE_SLUGS[slug] ? slug : null;
  }

  function send(event, props) {
    if (!ENABLED) return;
    if (!ALLOWED_EVENTS[event]) return;

    var payload = { event: event };
    if (props && typeof props.scene === 'string') payload.scene = props.scene;

    var json = JSON.stringify(payload);

    try {
      // sendBeacon is fire-and-forget and survives page unload — ideal for
      // 'pageview' and 'render_complete' near navigation. Use text/plain to
      // qualify as a "simple request" and skip the CORS preflight.
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) { /* fall through */ }

    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: json,
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
      }).catch(function () { /* swallow */ });
    } catch (e) { /* swallow */ }
  }

  window.track = send;

  // Auto-fire on load.
  function autoFire() {
    var scene = deriveScene();
    if (scene) {
      send('scene_open', { scene: scene });
    } else {
      // Treat anything that isn't a known scene page as the index pageview.
      // (info-box.js and other shared modules already only run on pages we
      // ship, so this is safe.)
      send('pageview');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoFire, { once: true });
  } else {
    autoFire();
  }
})();
