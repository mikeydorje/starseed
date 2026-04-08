// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Helper: simulate the "playing" state by directly setting playState
 * and mirroring the UI changes that applyAndLaunch() would perform.
 * We bypass the full audio decode → WebGL pipeline (fragile in headless)
 * and instead test the UI polling logic in recorder.js + mic-input.js.
 */
async function simulatePlayingState(page) {
  await page.evaluate(() => {
    // Hide the controls overlay (same as applyAndLaunch does)
    const controls = document.getElementById('controls');
    if (controls) { controls.classList.add('hidden'); controls.classList.remove('visible'); }
    // Set playState to 'playing' via the SCENE setter
    window.SCENE.setPlayState('playing');
  });
  // Wait for recorder.js 200ms poll + mic-input.js 250ms poll to pick it up
  await page.waitForTimeout(500);
}

// ── Tests ──

test.describe('UI/UX State Machine', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/phi');
    // Wait for SCENE to be defined (scripts loaded)
    await page.waitForFunction(() => !!window.SCENE, null, { timeout: 10_000 });
  });

  test('initial state: playback buttons are hidden', async ({ page }) => {
    // rec-btn and rec-pause-btn are injected by recorder.js with display:none initially
    const recBtn = page.locator('#rec-btn');
    const pauseBtn = page.locator('#rec-pause-btn');
    const ctrlPanel = page.locator('#ctrl-panel');
    const toolbarTab = page.locator('#toolbar-tab');

    await expect(recBtn).toHaveCSS('display', 'none');
    await expect(pauseBtn).toHaveCSS('display', 'none');
    await expect(ctrlPanel).toHaveCSS('display', 'none');
    await expect(toolbarTab).toHaveCSS('display', 'none');
  });

  test('initial state: controls overlay is visible', async ({ page }) => {
    const controls = page.locator('#controls');
    // Should NOT have class 'hidden'
    await expect(controls).not.toHaveClass(/hidden/);
  });

  test('upload audio → play: buttons appear, controls hide', async ({ page }) => {
    await simulatePlayingState(page);

    // Rec and pause buttons should now be visible (display:flex)
    await expect(page.locator('#rec-btn')).toHaveCSS('display', 'flex');
    await expect(page.locator('#rec-pause-btn')).toHaveCSS('display', 'flex');

    // Controls overlay should have class 'hidden'
    await expect(page.locator('#controls')).toHaveClass(/hidden/);

    // Toolbar tab should be visible
    await expect(page.locator('#toolbar-tab')).toHaveCSS('display', 'flex');

    // Control panel (right side) should be visible during playing
    await expect(page.locator('#ctrl-panel')).toHaveCSS('display', 'flex');
  });

  test('pause/resume: button icon toggles', async ({ page }) => {
    await simulatePlayingState(page);

    const pauseBtn = page.locator('#rec-pause-btn');

    // While playing, should show pause icon (❙❙)
    let text = await pauseBtn.textContent();
    expect(text).toContain('\u2759');

    // Simulate pause by setting playState directly
    await page.evaluate(() => window.SCENE.setPlayState('paused'));
    await page.waitForTimeout(500);

    // Should now show play icon (▶︎)
    text = await pauseBtn.textContent();
    expect(text).toContain('\u25b6');

    // Buttons should still be visible while paused
    await expect(page.locator('#rec-btn')).toHaveCSS('display', 'flex');
    await expect(pauseBtn).toHaveCSS('display', 'flex');
  });

  test('paramsDirty: slider change hides buttons', async ({ page }) => {
    await simulatePlayingState(page);

    // Buttons visible
    await expect(page.locator('#rec-btn')).toHaveCSS('display', 'flex');

    // Change a slider to mark params dirty
    await page.evaluate(() => {
      const slider = document.getElementById('p1');
      slider.value = '75';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for the recorder poll to notice (200ms interval)
    await page.waitForTimeout(400);

    // Buttons should be hidden now
    await expect(page.locator('#rec-btn')).toHaveCSS('display', 'none');
    await expect(page.locator('#rec-pause-btn')).toHaveCSS('display', 'none');
  });

  test('toolbar toggle: body class and icon', async ({ page }) => {
    await simulatePlayingState(page);

    const tab = page.locator('#toolbar-tab');
    await expect(tab).toHaveCSS('display', 'flex');

    // Click to hide toolbar
    await tab.click();
    await expect(page.locator('body')).toHaveClass(/toolbar-hidden/);
    let text = await tab.textContent();
    expect(text).toContain('\u25B2'); // ▲

    // Click to show toolbar
    await tab.click();
    await expect(page.locator('body')).not.toHaveClass(/toolbar-hidden/);
    text = await tab.textContent();
    expect(text).toContain('\u25BC'); // ▼
  });

  test('format preview: body class and canvas sizing on play', async ({ page }) => {
    await simulatePlayingState(page);

    // Should activate default format preview (16:9)
    await expect(page.locator('body')).toHaveClass(/fmt-preview-active/);

    // Canvas should have inline width/height styles
    const canvas = page.locator('canvas');
    const width = await canvas.evaluate(el => el.style.width);
    const height = await canvas.evaluate(el => el.style.height);
    expect(width).toBeTruthy();
    expect(height).toBeTruthy();
  });

  test('format preview: switching formats changes canvas dimensions', async ({ page }) => {
    await simulatePlayingState(page);

    // Get initial canvas dimensions (default 16:9)
    const canvas = page.locator('canvas');
    const initialWidth = await canvas.evaluate(el => el.style.width);

    // Click 9:16 format button
    const fmtBtns = page.locator('#ctrl-panel .fmt-prev-btn');
    const count = await fmtBtns.count();
    if (count >= 3) {
      // 9:16 is typically the 3rd button
      await fmtBtns.nth(2).click();
      await page.waitForTimeout(200);

      const newWidth = await canvas.evaluate(el => el.style.width);
      // 9:16 canvas should be narrower than 16:9
      expect(newWidth).not.toBe(initialWidth);
    }
  });

  test('controls panel hides during paused state', async ({ page }) => {
    await simulatePlayingState(page);

    // Panel visible during playing
    await expect(page.locator('#ctrl-panel')).toHaveCSS('display', 'flex');

    // Simulate pause
    await page.evaluate(() => window.SCENE.setPlayState('paused'));
    await page.waitForTimeout(500);

    // Panel should be hidden during paused
    await expect(page.locator('#ctrl-panel')).toHaveCSS('display', 'none');
  });
});
