---
name: audio-vis
description: "Audio-vis project context and conventions. Use when: editing scenes, adding scenes, modifying shaders, changing recorder, updating shared modules, debugging WebGL or audio issues, making bulk cross-scene changes. Covers architecture, 18-scene structure, window.SCENE contract, shader patterns, format preview system, and project rules."
---

# audio-vis — Project Skill

Browser-based audio-reactive particle visualizer. Static site (no build tools, no bundler), deployed on GitHub Pages. Three.js r128, WebGL, Web Audio API.

## Architecture

```
index.html              ← scene picker (18 cards)
<scene>.html + <scene>.js  ← 18 self-contained scene pairs
audio-store.js          ← IndexedDB audio cache (IIFE)
recorder.js             ← offline MP4 recorder (IIFE, WebCodecs + mp4-muxer CDN)
info-box.js             ← one-time info popup (IIFE)
main.js                 ← LEGACY / UNUSED — delete when convenient
```

No npm build. No transpilation. All modules load via `<script>` tags. Changes go live on push.

## The 18 Scenes

| Group | Scenes | Geometry | Shader behavior |
|-------|--------|----------|-----------------|
| **Original** (6) | Binary SMBH, Lotus, Ember, Filament, Spore, Lattice | **Deterministic** — concentric rings, layered petals, strand grids, computed density | Physical displacement (jets, ripples, curls, tension snaps) |
| **Mathematical** (6) | Pi, Tau, Phi, Euler, Feigenbaum, Mathematical Pony | **Deterministic** — spirals, grids, bifurcation trees, Lissajous | Morphs positions into mathematical forms (rose curves, epicycloids, bifurcation cascades) |
| **Shoegaze** (6) | Only Shallow, To Here Knows When, When You Sleep, I Only Said, Sometimes, Blown A Wish | **Random** — `(Math.random()-0.5)*range` scatter in 3D volume | Soft gradients, decentralized diffuse aesthetics |

Originals and math scenes both build **structured geometry** that the shader displaces. Shoegaze scenes are the outliers with random particle scattering. Param naming: math uses Growth/Phyllotaxis/Spectrum…, shoegaze uses Tremolo/Feedback/Saturation/Tape Head…

All 18 follow **identical structural patterns** — bulk changes via `sed` or scripted edits are standard practice.

## Scene HTML Template

Every `<scene>.html` contains, in order:

1. `<!DOCTYPE html>` + viewport meta
2. **Inline `<style>`** — full CSS (dark background, slider styles, button styles). Math scenes use green/gold accents; shoegaze scenes use red/orange.
3. **Body structure:**
   - Back button (`← back`) linking to `index.html`
   - Fullscreen toggle button
   - `<canvas id="canvas">` — Three.js render target
   - Audio upload UI: file `<input>` + styled label. Uses explicit extension + MIME list for iOS (`accept=".mp3,.wav,.ogg,.m4a,.aac,.flac,.webm,.opus,audio/mpeg,audio/wav,..."`)
   - Play button (▶︎ U+FE0E text presentation)
   - 8 parameter sliders (`p1`–`p8`), each 0–100, with scene-specific labels
4. **Scripts** (order matters):
   ```html
   <script src="audio-store.js"></script>
   <script src="<scene>.js"></script>
   <script src="recorder.js"></script>
   <script src="info-box.js"></script>
   ```

## Scene JS Template

Every `<scene>.js` contains, in order:

1. **Shaders** — vertex + fragment as template literals
2. **Three.js setup** — scene, camera (PerspectiveCamera), renderer (bound to `#canvas`), `setPixelRatio(1)`, initial size
3. **Uniforms** — includes `uFrequencyData` (Float32Array(64)), `uTime`, `uViewport`, `uThreshold`, plus 5–8 scene-specific params
4. **Slider bindings** — read `p1`–`p8` inputs, map to uniforms
5. **`computeSeedValues()`** — normalizes slider 0–100 → 0–1, derives rotSpeeds, smoothing, detail
6. **Particle geometry builder** — deterministic for original + math scenes, random for shoegaze
7. **Audio init + playback** — AudioContext, AnalyserNode (FFT 128 → 64 bins), file upload via audio-store.js
8. **Narrative arc function** (`storyArc`) — per-scene function mapping `progress` (0–1) to parameter multipliers
9. **Drift cycles** — slow autonomous rotation/scale oscillation (DRIFT_BASE typically 240s)
10. **Animation loop** — updates time, injects frequency data, applies arc + drift
11. **`window.SCENE` export** — the contract shared modules depend on
12. **`animate()` call**

## window.SCENE Contract

Every scene JS must expose this object. Recorder.js and other shared modules read it directly.

```js
window.SCENE = {
  // Three.js objects (direct references)
  scene, camera, renderer, uniforms, frequencyUniform,

  // Mutable state (getters — must reflect current values)
  get particles()       { return particles; },
  get seedCenter()      { return seedCenter; },
  get rotSpeedY()       { return rotSpeedY; },
  get rotSpeedX()       { return rotSpeedX; },
  get bakedArcScale()   { return bakedEpoch; },   // narrative arc value
  get bakedDriftScale() { return bakedFlux; },     // drift scale value

  // Drift config (static)
  driftCycles,          // array of { period, depth } objects
  DRIFT_BASE,           // base period in seconds (typically 240)

  // Uniform mapping — flat { driftKey: 'uUniformName' } lookup
  uniformMap: uMap,     // lets animation loop + recorder resolve which uniform to write per drift/arc param

  // Rotation config
  rotXMult: 0.06,       // math: 0.06, shoegaze: 0.03
  rotDriftScale: 0,
  tiltDriftScale: 0,

  // Narrative arc
  storyArc,             // function(progress) → { paramA: multiplier, paramB: multiplier, ... }

  // Audio state (getters)
  get currentBuffer()   { return currentBuffer; },
  get audioDuration()   { return audioDuration; },
  get audioContext()     { return audioContext; },
  get analyser()        { return analyser; },
  get playState()       { return playState; },

  // Scene identifier
  sceneName: '<scene-name>'
};
```

**Key differences:** `rotXMult` is `0.06` for original + math scenes, `0.03` for shoegaze. Shoegaze scenes also add a `rot` key in `storyArc` output for rotation intensity.

## Narrative Arc (`storyArc`)

Each scene defines its own `storyArc(progress)` function. No shared implementation, but all follow the same skeleton:

- **Input:** `progress` (0–1, playback position)
- **Helper:** local `sm(edge0, edge1, x)` — Hermite smoothstep `t²(3-2t)`
- **Output:** object with one multiplier per driftable parameter
- **5-phase shape** (scene-specific weights per parameter):
  1. **Wake** (0–15%): gentle rise from low baseline
  2. **Build** (15–45%): steep climb
  3. **Peak/plateau** (45–65%): build levels off
  4. **Soften** (65–85%): partial pullback
  5. **Fade** (85–100%): drops toward zero

Example weights: SMBH's `bloomAmp` → `0.3 + 0.3*wake + 0.5*build - 0.2*soften - 0.5*fade`. Same skeleton, different numbers per scene and per parameter. Shoegaze arcs also return a `rot` key for rotation intensity.

## Boundary-Aware Particle Shader

Every vertex shader clamps particles in NDC so they bounce off viewport edges instead of hard-clipping:

```glsl
vec2 pointRadiusNDC = gl_PointSize / uViewport;
vec2 maxNDC = max(vec2(1.0) - pointRadiusNDC, vec2(0.0));
ndc.xy = clamp(ndc.xy, -maxNDC, maxNDC)
       + bounceFactor * (ndc.xy - clamp(ndc.xy, -maxNDC, maxNDC));
```

- **Shoegaze** bounce factor: `0.3`
- **Math** bounce factor: `0.4`
- The `max(..., vec2(0.0))` prevents undefined behavior when point size exceeds viewport (relevant in 9:16 portrait).

## Format Preview & Recording

`recorder.js` provides:

- **Three format toggle buttons** (16:9, 1:1, 9:16) shown during playback
- Default format on play is **16:9**
- Renderer runs at exact output resolution: `setPixelRatio(1)`, `setSize(width, height, false)`
  - 16:9 → 1920×1080
  - 1:1  → 1080×1080
  - 9:16 → 1080×1920
- CSS scales the canvas to fit the viewport (no rendering resolution change on window resize)
- Preview is meant to be pixel-identical to recorded output
- Recording: WebCodecs + mp4-muxer, 60fps, 12Mbps
- Recorder has its own 128-point FFT for offline frame-by-frame audio analysis

**Status:** Format preview is the most recent area of work and may still need refinement.

## Emoji / Unicode

All emoji-capable Unicode (▶ ⏺ ◉ ⛰ ♪ ☾ ❄ ♡) uses **U+FE0E** (Variation Selector 15) to force text presentation. Never use bare emoji codepoints.

## index.html — Scene Picker

18 `<a class="scene-card">` elements, each with:
- `href="<scene>.html"`
- `<span class="icon">` — unicode symbol (with VS15 where needed)
- `<div class="name">` — display name
- `<div class="desc">` — one-line description

Bottom: "Reset Info Popups" button (hidden until localStorage has dismissed hints).

## Procedures

### Adding a New Scene

1. Copy an existing HTML + JS pair that matches the desired group (math/shoegaze/original)
2. Rename both files to the new scene name
3. Update the HTML: title, slider labels, accent colors, script `src`
4. Update the JS: shaders, geometry builder, uniforms, `sceneName` in `window.SCENE`
5. Maintain the boundary-aware shader pattern with correct bounce factor
6. Add a card to `index.html` in the appropriate group position
7. Test all three format previews (16:9, 1:1, 9:16)

### Making Bulk Cross-Scene Changes

All 18 scenes share identical structural patterns. When changing a shared pattern:

1. Identify the exact text to change (it will be near-identical across all 18 JS files)
2. Use `sed -i` or scripted find/replace across all scene JS files
3. Verify with `grep` that the change applied correctly to all 18
4. Spot-check 2–3 scenes in browser (one from each group)

### Modifying Shared Modules

Changes to `recorder.js`, `info-box.js`, or `audio-store.js` affect all 18 scenes simultaneously. Test with at least one scene from each group after any shared module change.

## Rules

- **No git stage/commit/push without explicit user approval**
- Static site only — no npm build, no transpilation, no bundler
- All 18 scenes must stay structurally consistent
- Use U+FE0E for all emoji-capable Unicode — **nothing should ever render as an emoji**, always a single-color text symbol. Append `\uFE0E` (VS15 text presentation selector) to any codepoint that has emoji variants.
- iOS file inputs need explicit extension + MIME lists (not `accept="audio/*"`)

## Known Issues

- **Format preview** — Pixel-perfect preview (render at exact res, CSS scale to fit) was the latest fix. May still have aspect ratio or fidelity issues.
- **main.js** — Legacy unused file. Not loaded by any HTML. Should be deleted.
- **Performance** — No profiling/optimization pass has been done across the 18 heavy particle scenes.
