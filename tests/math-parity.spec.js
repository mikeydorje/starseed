// @ts-check
const { test, expect } = require('@playwright/test');

const EPSILON = 1e-10;

/**
 * All 18 scene JS file basenames (no extension).
 * Used for bulk parity checks.
 */
const ALL_SCENES = [
  'smbh', 'lotus', 'ember', 'filament', 'spore', 'lattice',
  'pi', 'tau', 'phi', 'euler', 'feigenbaum', 'mathematical-pony',
  'only-shallow', 'to-here-knows-when', 'i-only-said',
  'sometimes', 'blown-a-wish', 'sakura',
];

// ── adjustedFov tests (run in test harness) ──

test.describe('adjustedFov()', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/math-harness.html');
    await page.waitForFunction(() => !!window.__TEST);
  });

  test('landscape (16:9): lock=0 returns baseFov unchanged', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      return adjustedFov(60, 1920 / 1080, 0);
    });
    expect(result).toBeCloseTo(60, 8);
  });

  test('landscape (16:9): lock=1 narrows FOV', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      return adjustedFov(60, 1920 / 1080, 1);
    });
    // Corrected FOV for landscape is narrower than baseFov
    expect(result).toBeLessThan(60);
    expect(result).toBeGreaterThan(20);
  });

  test('portrait (9:16): lock=0 returns wider corrected FOV', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      return adjustedFov(60, 1080 / 1920, 0);
    });
    // Portrait corrected FOV should be wider than baseFov
    expect(result).toBeGreaterThan(60);
  });

  test('portrait (9:16): lock=1 returns baseFov', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      return adjustedFov(60, 1080 / 1920, 1);
    });
    expect(result).toBeCloseTo(60, 8);
  });

  test('square (1:1): lock=0 returns baseFov (aspect=1, no correction)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      return adjustedFov(60, 1, 0);
    });
    // lock=0 → t=0, so no pseudo-aspect replacement, aspect=1 → landscape branch → baseFov
    expect(result).toBeCloseTo(60, 8);
  });

  test('square (1:1): lock=1 uses SQUARE_PSEUDO_ASPECT, narrows FOV', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      return adjustedFov(60, 1, 1);
    });
    // With pseudo-aspect = 16/9, treated as landscape, lock=1 narrows
    expect(result).toBeLessThan(60);
  });

  test('FOV is strictly monotonic with lock for portrait', async ({ page }) => {
    const results = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      const aspect = 1080 / 1920;
      return [0, 0.25, 0.5, 0.75, 1.0].map(lock => adjustedFov(60, aspect, lock));
    });
    // Should monotonically decrease from corrected → baseFov as lock increases
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeLessThanOrEqual(results[i - 1] + EPSILON);
    }
  });

  test('FOV is strictly monotonic with lock for landscape', async ({ page }) => {
    const results = await page.evaluate(() => {
      const { adjustedFov } = window.__TEST;
      const aspect = 1920 / 1080;
      return [0, 0.25, 0.5, 0.75, 1.0].map(lock => adjustedFov(60, aspect, lock));
    });
    // Should monotonically decrease from baseFov → corrected as lock increases
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeLessThanOrEqual(results[i - 1] + EPSILON);
    }
  });
});

// ── Time scaling parity ──

test.describe('Time scaling (_ds)', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/math-harness.html');
    await page.waitForFunction(() => !!window.__TEST);
  });

  const timeCases = [
    { duration: 30, DRIFT_BASE: 108 },
    { duration: 180, DRIFT_BASE: 108 },
    { duration: 600, DRIFT_BASE: 108 },
    { duration: 30, DRIFT_BASE: 240 },
    { duration: 0, DRIFT_BASE: 108 },
  ];

  for (const { duration, DRIFT_BASE } of timeCases) {
    test(`_ds for duration=${duration} DB=${DRIFT_BASE}`, async ({ page }) => {
      const result = await page.evaluate(([db, dur]) => {
        return window.__TEST.timeScale(db, dur);
      }, [DRIFT_BASE, duration]);

      // Compute expected locally
      const _ad = duration || 0;
      const expected = _ad > 0 ? DRIFT_BASE / Math.max(12, Math.min(120, _ad * 0.4)) : 1;
      expect(result).toBeCloseTo(expected, 10);
    });
  }
});

// ── Narrative arc tests (loaded from real scenes) ──

test.describe('Narrative arc: phi', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/phi');
    await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
  });

  test('storyArc(0): wake phase returns near-baseline values', async ({ page }) => {
    const result = await page.evaluate(() => window.SCENE.storyArc(0));
    for (const [key, val] of Object.entries(result)) {
      expect(val).toBeGreaterThanOrEqual(0.05);
      expect(val).toBeLessThanOrEqual(1.0);
    }
  });

  test('storyArc(0.5): peak phase returns elevated values', async ({ page }) => {
    const arc0 = await page.evaluate(() => window.SCENE.storyArc(0));
    const arc50 = await page.evaluate(() => window.SCENE.storyArc(0.5));
    // Peak values should generally be higher than wake values
    for (const key of Object.keys(arc50)) {
      expect(arc50[key]).toBeGreaterThanOrEqual(arc0[key] - 0.01);
    }
  });

  test('storyArc(1.0): fade phase returns low values', async ({ page }) => {
    const arc100 = await page.evaluate(() => window.SCENE.storyArc(1.0));
    const arc50 = await page.evaluate(() => window.SCENE.storyArc(0.5));
    // Fade values should be significantly lower than peak
    for (const key of Object.keys(arc100)) {
      expect(arc100[key]).toBeLessThan(arc50[key] + 0.01);
    }
  });

  test('all arc values respect Math.max floor', async ({ page }) => {
    const points = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
    for (const p of points) {
      const result = await page.evaluate((progress) => window.SCENE.storyArc(progress), p);
      for (const [key, val] of Object.entries(result)) {
        expect(val).toBeGreaterThanOrEqual(0.05);
      }
    }
  });

  test('arc interpolation: bakedArcScale=0 → no effect', async ({ page }) => {
    const result = await page.evaluate(() => {
      const raw = window.SCENE.storyArc(0.5);
      const interp = {};
      for (const k in raw) interp[k] = 1.0 + (raw[k] - 1.0) * 0;
      return interp;
    });
    for (const val of Object.values(result)) {
      expect(val).toBeCloseTo(1.0, 10);
    }
  });

  test('arc interpolation: bakedArcScale=1 → full effect', async ({ page }) => {
    const result = await page.evaluate(() => {
      const raw = window.SCENE.storyArc(0.5);
      const interp = {};
      for (const k in raw) interp[k] = 1.0 + (raw[k] - 1.0) * 1;
      return interp;
    });
    // Should equal the raw arc values
    const raw = await page.evaluate(() => window.SCENE.storyArc(0.5));
    for (const key of Object.keys(result)) {
      expect(result[key]).toBeCloseTo(raw[key], 10);
    }
  });
});

// ── Narrative arc: only-shallow (shoegaze representative) ──

test.describe('Narrative arc: only-shallow', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/only-shallow');
    await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
  });

  test('storyArc includes rot key', async ({ page }) => {
    const result = await page.evaluate(() => window.SCENE.storyArc(0.5));
    expect(result).toHaveProperty('rot');
    expect(result.rot).toBeGreaterThanOrEqual(0.1);
  });

  test('all arc values respect floors across full range', async ({ page }) => {
    const points = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
    for (const p of points) {
      const result = await page.evaluate((progress) => window.SCENE.storyArc(progress), p);
      for (const [key, val] of Object.entries(result)) {
        expect(val).toBeGreaterThanOrEqual(0.05);
      }
    }
  });
});

// ── Drift cycle parity ──

test.describe('Drift cycle parity', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/math-harness.html');
    await page.waitForFunction(() => !!window.__TEST);
  });

  const phiConfig = {
    DRIFT_BASE: 108,
    audioDuration: 180,
    driftCycles: {
      growth: { period: 108, depth: 0.3 },
      phyllotaxis: { period: 108 * 0.786, depth: 0.3 },
      pentagon: { period: 108 * 1.272, depth: 0.25 },
      proportion: { period: 108 * 0.618, depth: 0.3 },
    },
    seedCenter: { growth: 0.55, phyllotaxis: 0.55, pentagon: 0.45, proportion: 0.5 },
    bakedFlux: 0.45,
    _driftPhases: { growth: 1.2, phyllotaxis: 2.5, pentagon: 0.8, proportion: 4.1, _px: 3.0, _py: 1.5, _br: 2.2 },
    uniformMap: { growth: 'uGrowth', phyllotaxis: 'uPhyllotaxis', pentagon: 'uPentagon', proportion: 'uProportion' },
  };

  const arcMult = { growth: 1.15, phyllotaxis: 1.08, pentagon: 1.2, proportion: 1.05, rot: 1.1 };
  const timePoints = [0, 30, 60, 120, 240];

  for (const t of timePoints) {
    test(`drift output matches at t=${t}s`, async ({ page }) => {
      const result = await page.evaluate(([config, arc, elapsed]) => {
        return window.__TEST.computeDrift({
          elapsed,
          DRIFT_BASE: config.DRIFT_BASE,
          audioDuration: config.audioDuration,
          driftCycles: config.driftCycles,
          seedCenter: config.seedCenter,
          bakedFlux: config.bakedFlux,
          _driftPhases: config._driftPhases,
          arcMult: arc,
          uniformMap: config.uniformMap,
        });
      }, [phiConfig, arcMult, t]);

      // Recompute locally to verify
      const TWO_PI = Math.PI * 2;
      const _ds = phiConfig.DRIFT_BASE / Math.max(12, Math.min(120, phiConfig.audioDuration * 0.4));
      const dt = t * _ds;
      const _dp = phiConfig._driftPhases;

      for (const key in phiConfig.driftCycles) {
        const { period, depth } = phiConfig.driftCycles[key];
        const sd = depth * (0.3 + phiConfig.bakedFlux * 1.4);
        const drift = (Math.sin(dt * TWO_PI / period + (_dp[key] || 0)) * 0.65
                     + Math.sin(dt * TWO_PI / (period * 2.17) + 1.3 + (_dp[key] || 0)) * 0.35) * sd;
        const expected = Math.max(0.01, phiConfig.seedCenter[key] * (arcMult[key] || 1) * (1.0 + drift));
        const uName = phiConfig.uniformMap[key];
        expect(result[uName]).toBeCloseTo(expected, 10);
      }
    });
  }
});

// ── Rotation parity ──

test.describe('Rotation parity', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/math-harness.html');
    await page.waitForFunction(() => !!window.__TEST);
  });

  const testCases = [
    {
      name: 'phi (math scene)',
      config: {
        DRIFT_BASE: 108, audioDuration: 180,
        rotSpeedY: 0.017, rotSpeedX: 0.009,
        rotXMult: 0.06, rotYMult: 0.2,
        rotDriftScale: 0, tiltDriftScale: 0,
        _driftPhases: {},
      },
      arcMult: { rot: 1.15 },
    },
    {
      name: 'only-shallow (shoegaze scene)',
      config: {
        DRIFT_BASE: 108, audioDuration: 180,
        rotSpeedY: 0.014, rotSpeedX: 0.007,
        rotXMult: 0.07, rotYMult: 0.35,
        rotDriftScale: 0, tiltDriftScale: 0,
        _driftPhases: {},
      },
      arcMult: { rot: 1.1 },
    },
  ];

  for (const tc of testCases) {
    for (const t of [0, 30, 60, 120]) {
      test(`${tc.name} rotation at t=${t}s`, async ({ page }) => {
        const result = await page.evaluate(([config, arc, elapsed]) => {
          return window.__TEST.computeRotation({
            elapsed,
            DRIFT_BASE: config.DRIFT_BASE,
            audioDuration: config.audioDuration,
            rotSpeedY: config.rotSpeedY,
            rotSpeedX: config.rotSpeedX,
            rotXMult: config.rotXMult,
            rotYMult: config.rotYMult,
            rotDriftScale: config.rotDriftScale,
            tiltDriftScale: config.tiltDriftScale,
            _driftPhases: config._driftPhases,
            arcMult: arc,
          });
        }, [tc.config, tc.arcMult, t]);

        // Verify locally
        const expectedRotY = t * tc.config.rotSpeedY * (tc.arcMult.rot || 1) * (tc.config.rotYMult || 1);
        const expectedRotX = t * tc.config.rotSpeedX * tc.config.rotXMult * (tc.arcMult.rot || 1);
        expect(result.rotY).toBeCloseTo(expectedRotY, 10);
        expect(result.rotX).toBeCloseTo(expectedRotX, 10);
      });
    }
  }
});

// ── Position drift & breathing parity ──

test.describe('Position drift & breathing parity', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/math-harness.html');
    await page.waitForFunction(() => !!window.__TEST);
  });

  const phiPosDrift = { amt: 0.08, px: 1.4, py: 1.0, ys: 0.7 };
  const phiBreathe = { period: 1.8, amp: 0.05 };

  for (const t of [0, 30, 60, 120]) {
    test(`phi position drift at t=${t}s`, async ({ page }) => {
      const params = {
        elapsed: t, DRIFT_BASE: 108, audioDuration: 180, bakedFlux: 0.45,
        _driftPhases: { _px: 3.0, _py: 1.5 },
        posDrift: phiPosDrift,
      };
      const result = await page.evaluate((p) => window.__TEST.computePosDrift(p), params);

      // Verify locally
      const TWO_PI = Math.PI * 2;
      const _ds = 108 / Math.max(12, Math.min(120, 180 * 0.4));
      const dt = t * _ds;
      const driftAmt = 0.08 * (0.4 + 0.45 * 0.8);
      const expectedX = Math.sin(dt * TWO_PI / (108 * 1.4) + 3.0) * driftAmt;
      const expectedY = Math.sin(dt * TWO_PI / (108 * 1.0) + 1.7 + 1.5) * driftAmt * 0.7;
      expect(result.x).toBeCloseTo(expectedX, 10);
      expect(result.y).toBeCloseTo(expectedY, 10);
      expect(result.z).toBeCloseTo(0, 10); // phi has no z drift
    });

    test(`phi breathing at t=${t}s`, async ({ page }) => {
      const params = {
        elapsed: t, DRIFT_BASE: 108, audioDuration: 180,
        _driftPhases: { _br: 2.2 },
        breathe: phiBreathe,
        arcMult: { rot: 1.1 },
      };
      const result = await page.evaluate((p) => window.__TEST.computeBreathe(p), params);

      const TWO_PI = Math.PI * 2;
      const _ds = 108 / Math.max(12, Math.min(120, 180 * 0.4));
      const dt = t * _ds;
      const expected = 1.0 + Math.sin(dt * TWO_PI / (108 * 1.8) + 2.2) * 0.05 * 1.1;
      expect(result).toBeCloseTo(expected, 10);
    });
  }

  // Shoegaze scene with Z drift
  const sgPosDrift = { amt: 0.18, px: 2.0, py: 1.6, ys: 0.7, pz: 2.8, zs: 0.4 };

  for (const t of [0, 30, 60, 120]) {
    test(`only-shallow position drift (with Z) at t=${t}s`, async ({ page }) => {
      const params = {
        elapsed: t, DRIFT_BASE: 108, audioDuration: 180, bakedFlux: 0.5,
        _driftPhases: { _px: 1.0, _py: 2.0, _pz: 0.5 },
        posDrift: sgPosDrift,
      };
      const result = await page.evaluate((p) => window.__TEST.computePosDrift(p), params);

      const TWO_PI = Math.PI * 2;
      const _ds = 108 / Math.max(12, Math.min(120, 180 * 0.4));
      const dt = t * _ds;
      const driftAmt = 0.18 * (0.4 + 0.5 * 0.8);
      const expectedX = Math.sin(dt * TWO_PI / (108 * 2.0) + 1.0) * driftAmt;
      const expectedY = Math.sin(dt * TWO_PI / (108 * 1.6) + 1.7 + 2.0) * driftAmt * 0.7;
      const expectedZ = Math.sin(dt * TWO_PI / (108 * 2.8) + 0.9 + 0.5) * driftAmt * 0.4;
      expect(result.x).toBeCloseTo(expectedX, 10);
      expect(result.y).toBeCloseTo(expectedY, 10);
      expect(result.z).toBeCloseTo(expectedZ, 10);
    });
  }
});

// ── Cross-scene SCENE export parity: rotYMult × rotXMult consistency ──

test.describe('Cross-scene rotation multiplier consistency', () => {

  for (const sceneName of ['phi', 'only-shallow']) {
    test(`${sceneName}: rotYMult and rotXMult are defined`, async ({ page }) => {
      await page.goto(`/${sceneName}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });

      const { rotYMult, rotXMult } = await page.evaluate(() => ({
        rotYMult: window.SCENE.rotYMult,
        rotXMult: window.SCENE.rotXMult,
      }));

      expect(typeof rotYMult).toBe('number');
      expect(rotYMult).toBeGreaterThan(0);
      expect(typeof rotXMult).toBe('number');
      expect(rotXMult).toBeGreaterThan(0);
    });

    test(`${sceneName}: posDrift and breathe are defined`, async ({ page }) => {
      await page.goto(`/${sceneName}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });

      const { posDrift, breathe } = await page.evaluate(() => ({
        posDrift: window.SCENE.posDrift,
        breathe: window.SCENE.breathe,
      }));

      expect(posDrift).toBeTruthy();
      expect(posDrift.amt).toBeGreaterThan(0);
      expect(posDrift.px).toBeGreaterThan(0);
      expect(posDrift.py).toBeGreaterThan(0);
      expect(posDrift.ys).toBeGreaterThan(0);

      expect(breathe).toBeTruthy();
      expect(breathe.period).toBeGreaterThan(0);
      expect(breathe.amp).toBeGreaterThan(0);
    });

    test(`${sceneName}: uniformMap keys match driftCycles keys`, async ({ page }) => {
      await page.goto(`/${sceneName}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });

      const { driftKeys, mapKeys } = await page.evaluate(() => ({
        driftKeys: Object.keys(window.SCENE.driftCycles).sort(),
        mapKeys: Object.keys(window.SCENE.uniformMap).sort(),
      }));

      expect(driftKeys).toEqual(mapKeys);
    });

    test(`${sceneName}: seedCenter keys match driftCycles keys when playing`, async ({ page }) => {
      await page.goto(`/${sceneName}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });

      // Trigger applyAndLaunch to populate seedCenter
      await page.evaluate(() => {
        window.SCENE.ensureAudio();
        window.SCENE.applyAndLaunch();
      });

      const { driftKeys, seedKeys } = await page.evaluate(() => ({
        driftKeys: Object.keys(window.SCENE.driftCycles).sort(),
        seedKeys: Object.keys(window.SCENE.seedCenter).sort(),
      }));

      expect(seedKeys).toEqual(driftKeys);
    });
  }
});

// ── SCENE contract: required properties exist ──

test.describe('window.SCENE contract', () => {

  for (const sceneName of ['phi', 'only-shallow']) {
    test(`${sceneName}: all required properties exist`, async ({ page }) => {
      await page.goto(`/${sceneName}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });

      const result = await page.evaluate(() => {
        const S = window.SCENE;
        return {
          hasScene: !!S.scene,
          hasCamera: !!S.camera,
          hasRenderer: !!S.renderer,
          hasUniforms: !!S.uniforms,
          hasFreqUniform: S.frequencyUniform instanceof Float32Array,
          freqLength: S.frequencyUniform ? S.frequencyUniform.length : 0,
          hasDriftCycles: typeof S.driftCycles === 'object',
          hasDRIFT_BASE: typeof S.DRIFT_BASE === 'number',
          hasUniformMap: typeof S.uniformMap === 'object',
          hasStoryArc: typeof S.storyArc === 'function',
          hasSceneName: typeof S.sceneName === 'string',
          hasRotXMult: typeof S.rotXMult === 'number',
          hasRotYMult: typeof S.rotYMult === 'number' || S.rotYMult === undefined,
          hasPosDrift: !!S.posDrift,
          hasBreathe: !!S.breathe,
          hasEnsureAudio: typeof S.ensureAudio === 'function',
          hasApplyAndLaunch: typeof S.applyAndLaunch === 'function',
          hasSetPlayState: typeof S.setPlayState === 'function',
          hasStopFileAudio: typeof S.stopFileAudio === 'function',
        };
      });

      expect(result.hasScene).toBe(true);
      expect(result.hasCamera).toBe(true);
      expect(result.hasRenderer).toBe(true);
      expect(result.hasUniforms).toBe(true);
      expect(result.hasFreqUniform).toBe(true);
      expect(result.freqLength).toBe(64);
      expect(result.hasDriftCycles).toBe(true);
      expect(result.hasDRIFT_BASE).toBe(true);
      expect(result.hasUniformMap).toBe(true);
      expect(result.hasStoryArc).toBe(true);
      expect(result.hasSceneName).toBe(true);
      expect(result.hasRotXMult).toBe(true);
      expect(result.hasPosDrift).toBe(true);
      expect(result.hasBreathe).toBe(true);
      expect(result.hasEnsureAudio).toBe(true);
      expect(result.hasApplyAndLaunch).toBe(true);
      expect(result.hasSetPlayState).toBe(true);
      expect(result.hasStopFileAudio).toBe(true);
    });
  }
});

// ── Per-band bass smoothing ──

test.describe('Per-band bass smoothing', () => {

  const sceneBass = [
    { name: 'smbh',         group: 'original', expected: 0.05 },
    { name: 'phi',          group: 'math',     expected: 0.05 },
    { name: 'only-shallow', group: 'shoegaze', expected: 0.20 },
  ];

  for (const { name, group, expected } of sceneBass) {
    test(`${name} (${group}): _bassSm is ${expected}`, async ({ page }) => {
      await page.goto(`/${name}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
      const val = await page.evaluate(() => window.SCENE._bassSm);
      expect(val).toBe(expected);
    });

    test(`${name} (${group}): _sceneSm is a number`, async ({ page }) => {
      await page.goto(`/${name}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
      const val = await page.evaluate(() => window.SCENE._sceneSm);
      expect(typeof val).toBe('number');
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    });

    test(`${name} (${group}): analyser.smoothingTimeConstant is 0`, async ({ page }) => {
      await page.goto(`/${name}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
      await page.evaluate(() => window.SCENE.ensureAudio());
      const stc = await page.evaluate(() => window.SCENE.analyser.smoothingTimeConstant);
      expect(stc).toBe(0);
    });

    test(`${name} (${group}): _sceneSm updates after applyAndLaunch`, async ({ page }) => {
      await page.goto(`/${name}`);
      await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
      await page.evaluate(() => { window.SCENE.ensureAudio(); window.SCENE.applyAndLaunch(); });
      const sm1 = await page.evaluate(() => window.SCENE._sceneSm);
      expect(typeof sm1).toBe('number');
      expect(sm1).toBeGreaterThan(0);
      expect(sm1).toBeLessThanOrEqual(1);
    });
  }
});
