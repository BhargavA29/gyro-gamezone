import { expect, test } from "@playwright/test";

test.describe("Host + Pad Pairing, Calibration, Reconnect, & Aim Lab", () => {
  test("pairs two browser contexts, calibrates, runs Aim Lab + Debug, reconnects in 30s grace, and opens /pad/debug", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    });
    const padContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });

    const hostPage = await hostContext.newPage();
    const padPage = await padContext.newPage();

    try {
      // 1. Desktop /host opens and creates room
      await hostPage.goto("/host");
      await expect(hostPage.locator("[data-status-label]")).toHaveText("Connected");

      const codeLocator = hostPage.locator(".pair-code-value");
      await expect(codeLocator).toHaveText(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
      const roomCode = (await codeLocator.textContent())!.trim();

      const qrImg = hostPage.locator("[data-qr-img]");
      await expect(qrImg).toHaveAttribute("src", /^data:image\/png;base64,/);

      // 2. Phone /pad opens and joins using room code
      await padPage.goto("/pad");
      await padPage.locator("#room-code").fill(roomCode);
      await padPage.locator("#player-name").fill("AlexPad");
      await padPage.getByRole("button", { name: /Join & Enable Motion/i }).click();

      await expect(padPage.locator(".slot-badge")).toContainText("P1 · AlexPad");
      await expect(hostPage.locator(".seats-grid")).toContainText("AlexPad");
      await expect(hostPage.locator(".seats-grid")).toContainText("Connected");

      // 3. Phone runs 3-step calibration while host reflects calibration state
      await padPage.locator("[data-start-calib]").click();
      await expect(padPage.getByText("1. Hold Still")).toBeVisible();
      await expect(padPage.locator("[data-lock-center]")).toBeVisible({ timeout: 5_000 });
      await expect(hostPage.locator(".seats-grid")).toContainText("2/3 Point center");

      await padPage.locator("[data-lock-center]").click();
      await expect(padPage.locator("[data-skip-range]")).toBeVisible();
      await padPage.locator("[data-skip-range]").click();

      await expect(padPage.locator("[data-pad-surface]")).toBeVisible();
      await expect(hostPage.locator(".seats-grid")).toContainText("Calibrated");

      // 4. Launch Aim Dot Calibration Lab on Host and verify WebGL stage + Debug telemetry
      await hostPage.locator("[data-quick-aim]").click();
      const canvas = hostPage.locator("canvas.host-stage-canvas");
      await expect(canvas).toBeVisible();

      await hostPage.locator("[data-toggle-debug]").click();
      await expect(hostPage.locator(".debug-drawer")).toContainText("FPS:");
      await expect(hostPage.locator(".debug-drawer")).toContainText("P1");

      // 5. Simulate phone reload / brief drop -> graceful reconnect back to same P1 slot
      await padPage.reload();
      await expect(padPage.locator(".slot-badge")).toContainText("P1 · AlexPad", {
        timeout: 10_000,
      });

      // 6. Verify /pad/debug sensor waveform viewer
      await padPage.goto("/pad/debug");
      await expect(
        padPage.getByRole("heading", { name: /Raw vs Filtered Telemetry/i }),
      ).toBeVisible();
      await expect(padPage.locator("canvas")).toBeVisible();
    } finally {
      await padContext.close();
      await hostContext.close();
    }
  });

  test("toggles light/dark theme and validates join form inputs", async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      await page.goto("/host");
      await expect(page.locator("[data-status-label]")).toHaveText("Connected");

      const schemeMeta = page.locator('meta[name="color-scheme"]');
      await expect(schemeMeta).toHaveAttribute("content", "dark");

      await page.locator("[data-theme-toggle]").click();
      await expect(schemeMeta).toHaveAttribute("content", "light");

      await page.locator("[data-theme-toggle]").click();
      await expect(schemeMeta).toHaveAttribute("content", "dark");

      // Invalid room code triggers inline accessible error (without submitting)
      await page.goto("/pad");
      await page.locator("#room-code").fill("AB");
      await page.getByRole("button", { name: /Join & Enable Motion/i }).click();
      await expect(page.locator("#room-code-err")).toContainText("4-character");
    } finally {
      await context.close();
    }
  });

  test("runs desktop mouse-as-gyro simulator inside Aim Lab without a phone", async ({ browser }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    try {
      await page.goto("/host");
      await expect(page.locator("[data-status-label]")).toHaveText("Connected");

      await page.locator("[data-toggle-sim]").click();
      await expect(page.locator("[data-toggle-sim]")).toContainText("Stop Sim (P1)");
      await expect(page.locator(".seats-grid")).toContainText("Desktop Sim");
      await expect(page.locator(".seats-grid")).toContainText("Calibrated");

      await page.locator("[data-quick-aim]").click();
      const canvas = page.locator("canvas.host-stage-canvas");
      await expect(canvas).toBeVisible();

      await page.locator("[data-toggle-debug]").click();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Missing stage canvas bounding box");
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);

      await expect(page.locator(".debug-drawer")).toContainText("Last gesture: P1 · tap");
    } finally {
      await context.close();
    }
  });

  test("launches Target Shooting through countdown, plays 60s gallery, fires/reloads, and renders Shareable Result Card", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    try {
      await page.goto("/host");
      await expect(page.locator("[data-status-label]")).toHaveText("Connected");

      await page.locator("[data-toggle-sim]").click();
      await expect(page.locator("[data-play-targets]")).toBeEnabled();
      await page.locator("[data-play-targets]").click();

      // Countdown banner shows first, then transitions to playing with round timer
      const countdown = page.locator("[data-countdown-banner]");
      await expect(countdown).toBeVisible();
      await expect(countdown).toBeHidden({ timeout: 6_000 });

      const timer = page.locator("[data-hud-timer]");
      await expect(timer).toBeVisible();
      await expect(timer).toContainText("s");

      const canvas = page.locator("canvas.host-stage-canvas");
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Missing stage canvas bounding box");

      // Fire simulator shots and test wrist-flick reload shortcut (R)
      await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.44);
      await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.44);
      await page.keyboard.press("r");

      // Finish round early into Results Leaderboard + Shareable PNG Card
      await page.locator("[data-stage-finish]").click();
      await expect(
        page.getByRole("heading", { name: /Target Shooting Results/i }),
      ).toBeVisible();
      await expect(page.locator(".results-list")).toContainText("Desktop Sim");
      await expect(page.locator("[data-result-card-img]")).toHaveAttribute(
        "src",
        /^data:image\/png;base64,/,
      );
      await expect(page.locator("[data-download-card]")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
