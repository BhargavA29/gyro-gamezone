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

      // Switch difficulty preset in lobby before launch and verify active state
      const proBtn = page.locator('[data-set-difficulty="pro"]');
      await proBtn.click();
      await expect(proBtn).toHaveAttribute("aria-pressed", "true");
      const casualBtn = page.locator('[data-set-difficulty="casual"]');
      await casualBtn.click();
      await expect(casualBtn).toHaveAttribute("aria-pressed", "true");

      await expect(page.locator("[data-play-targets]")).toBeEnabled();
      await page.locator("[data-play-targets]").click();

      // Countdown banner shows first, then transitions to playing with round timer + difficulty pill
      const countdown = page.locator("[data-countdown-banner]");
      await expect(countdown).toBeVisible();
      await expect(countdown).toBeHidden({ timeout: 6_000 });

      const timer = page.locator("[data-hud-timer]");
      await expect(timer).toBeVisible();
      await expect(timer).toContainText("s");
      await expect(page.locator("[data-hud-difficulty]")).toHaveText("Chill");

      const canvas = page.locator("canvas.host-stage-canvas");
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Missing stage canvas bounding box");

      // Fire 7 simulator shots to empty 6-shot mag + trigger dry fire reload prompt, then press R to reload
      const cx = box.x + box.width * 0.42;
      const cy = box.y + box.height * 0.44;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 7; i++) {
        await page.mouse.click(cx, cy);
      }
      await expect(page.locator("[data-hud-announce]")).toContainText("Empty!");
      await expect(page.locator('.ammo-dot[data-filled="true"]')).toHaveCount(0);

      await page.keyboard.press("r");
      await expect(page.locator('.ammo-dot[data-filled="true"]')).toHaveCount(6);

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

  test("syncs Target Shooting difficulty, 6-pip magazine HUD, empty warning, and one-tap reload between /host and /pad", async ({
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
      await hostPage.goto("/host");
      await expect(hostPage.locator("[data-status-label]")).toHaveText("Connected");
      const roomCode = (await hostPage.locator(".pair-code-value").textContent())!.trim();

      await hostPage.locator('[data-set-difficulty="pro"]').click();
      await expect(hostPage.locator('[data-set-difficulty="pro"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      await padPage.goto(`/pad?room=${roomCode}`);
      await padPage.locator("#player-name").fill("PadShooter");
      await padPage.getByRole("button", { name: /Join & Enable Motion/i }).click();
      await expect(padPage.locator(".slot-badge")).toContainText("P1 · PadShooter");

      await hostPage.locator("[data-play-targets]").click();
      await expect(hostPage.locator("[data-countdown-banner]")).toBeHidden({ timeout: 6_000 });
      await expect(hostPage.locator("[data-hud-difficulty]")).toHaveText("Turbo 1.25×");

      const reloadBtn = padPage.locator("[data-pad-reload]");
      await expect(reloadBtn).toBeVisible();
      await expect(reloadBtn).toContainText("Ready 6/6");
      await expect(padPage.locator('.pad-mag-pip[data-filled="true"]')).toHaveCount(6);

      // Tap pad surface 6 times quickly to empty magazine cleanly without hitting reload button
      const surface = padPage.locator("[data-pad-surface]");
      const sBox = await surface.boundingBox();
      if (!sBox) throw new Error("Missing pad surface box");
      for (let i = 0; i < 6; i++) {
        await padPage.mouse.click(sBox.x + sBox.width * 0.5, sBox.y + 36);
      }

      await expect(reloadBtn).toHaveAttribute("data-urgent", "true");
      await expect(reloadBtn).toContainText("EMPTY!");
      await expect(padPage.locator('.pad-mag-pip[data-filled="true"]')).toHaveCount(0);

      // Tap phone reload button and verify magazine refills on both pad & host
      await reloadBtn.click();
      await expect(reloadBtn).toHaveAttribute("data-urgent", "false");
      await expect(reloadBtn).toContainText("Ready 6/6");
      await expect(padPage.locator('.pad-mag-pip[data-filled="true"]')).toHaveCount(6);
      await expect(hostPage.locator('.ammo-dot[data-filled="true"]')).toHaveCount(6);
    } finally {
      await padContext.close();
      await hostContext.close();
    }
  });

  test("launches Fruit Slicer with Host + Pad, syncs slice HUD, handles continuous swipe & renders Results PNG", async ({
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
      await hostPage.goto("/host");
      await expect(hostPage.locator("[data-status-label]")).toHaveText("Connected");
      const roomCode = (await hostPage.locator(".pair-code-value").textContent())!.trim();

      await padPage.goto(`/pad?room=${roomCode}`);
      await padPage.locator("#player-name").fill("BladeNinja");
      await padPage.getByRole("button", { name: /Join & Enable Motion/i }).click();
      await expect(padPage.locator(".slot-badge")).toContainText("P1 · BladeNinja");

      await hostPage.locator("[data-play-fruits]").click();
      await expect(hostPage.locator("[data-countdown-banner]")).toBeVisible();
      await expect(hostPage.locator("[data-countdown-banner]")).toBeHidden({ timeout: 6_000 });

      await expect(hostPage.locator("[data-hud-title]")).toHaveText("Fruit Slicer");
      await expect(hostPage.locator("[data-hud-difficulty]")).toHaveText("Arcade");
      await expect(hostPage.locator("[data-hud-timer]")).toBeVisible();
      await expect(hostPage.locator("canvas.host-stage-canvas.host-sword-cursor")).toBeVisible();
      await expect(hostPage.locator("[data-hud-scoreboard] .life-pip[data-alive=\"true\"]")).toHaveCount(3);

      // Pad hides Target Shooting controls, displays 3 life hearts and live Fruit Slicer prompt
      await expect(padPage.locator("[data-pad-reload]")).toBeHidden();
      await expect(padPage.locator("[data-pad-ammo]")).toBeHidden();
      await expect(padPage.locator("[data-pad-lives]")).toBeVisible();
      await expect(padPage.locator('.pad-life-pip[data-alive="true"]')).toHaveCount(3);
      await expect(padPage.locator("[data-gesture-readout]")).toContainText(
        "Hold=Safe Move · Fast=Slice!",
      );

      // Hold + calm slide on phone stays in Safe Move mode (must NOT emit swipe or tap)
      await hostPage.locator("[data-toggle-debug]").click();
      const surface = padPage.locator("[data-pad-surface]");
      const sBox = await surface.boundingBox();
      if (!sBox) throw new Error("Missing pad surface bounding box");
      await padPage.mouse.move(sBox.x + 60, sBox.y + sBox.height * 0.5);
      await padPage.mouse.down();
      await padPage.waitForTimeout(210);
      await padPage.mouse.move(sBox.x + 140, sBox.y + sBox.height * 0.5, { steps: 6 });
      await padPage.mouse.up();
      await expect(hostPage.locator(".debug-drawer")).toContainText("Last gesture: P1 · hold_end");

      // Fast intentional whip swipe across phone surface DOES trigger slice swipe
      await padPage.mouse.move(sBox.x + 28, sBox.y + sBox.height * 0.72);
      await padPage.mouse.down();
      await padPage.mouse.move(sBox.x + sBox.width - 28, sBox.y + sBox.height * 0.28, { steps: 4 });
      await padPage.mouse.up();
      await expect(hostPage.locator(".debug-drawer")).toContainText("Last gesture: P1 · swipe");

      await hostPage.locator("[data-stage-finish]").click();
      await expect(hostPage.getByRole("heading", { name: /Fruit Slicer Results/i })).toBeVisible();
      await expect(hostPage.locator(".results-list")).toContainText("BladeNinja");
      await expect(hostPage.locator("[data-result-card-img]")).toHaveAttribute(
        "src",
        /^data:image\/png;base64,/,
      );
    } finally {
      await padContext.close();
      await hostContext.close();
    }
  });

  test("plays Fruit Slicer in Simulator mode with mouse sweeps and Space slash", async ({
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
      await page.locator('[data-set-difficulty="casual"]').click();

      await page.locator("[data-play-fruits]").click();
      await expect(page.locator("[data-countdown-banner]")).toBeHidden({ timeout: 6_000 });
      await expect(page.locator("[data-hud-difficulty]")).toHaveText("Chill");

      const canvas = page.locator("canvas.host-stage-canvas");
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Missing stage canvas bounding box");

      await page.locator("[data-toggle-debug]").click();
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.65);
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.35, { steps: 6 });
      await page.keyboard.press("Space");
      await expect(page.locator(".debug-drawer")).toContainText("Last gesture: P1 · swing");

      await page.locator("[data-stage-finish]").click();
      await expect(page.getByRole("heading", { name: /Fruit Slicer Results/i })).toBeVisible();
      await expect(page.locator("[data-download-card]")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("pairs phone, plays Archery round with hold-to-draw bow & release, and renders results card", async ({
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
      await hostPage.goto("/host");
      await expect(hostPage.locator("[data-status-label]")).toHaveText("Connected");
      const roomCode = (await hostPage.locator(".pair-code-value").textContent())!.trim();

      await padPage.goto(`/pad?room=${roomCode}`);
      await padPage.locator("#player-name").fill("RobinHood");
      await padPage.getByRole("button", { name: /Join & Enable Motion/i }).click();
      await expect(padPage.locator(".slot-badge")).toContainText("P1 · RobinHood");

      await hostPage.locator("[data-play-archery]").click();
      await expect(hostPage.locator("[data-countdown-banner]")).toBeVisible();
      await expect(hostPage.locator("[data-countdown-banner]")).toBeHidden({ timeout: 6_000 });

      await expect(hostPage.locator("[data-hud-title]")).toHaveText("Archery");
      await expect(hostPage.locator("[data-hud-difficulty]")).toHaveText("Arcade");
      await expect(hostPage.locator("[data-hud-wind]")).toBeVisible();
      await expect(hostPage.locator("[data-hud-wind]")).toContainText("Wind");
      await expect(hostPage.locator("[data-hud-timer]")).toHaveText("End 1/6");
      await expect(hostPage.locator("[data-hud-scoreboard] .attempt-box")).toHaveCount(6);

      // Pad shows Draw Tension meter and hides Target/Fruit HUD widgets
      await expect(padPage.locator("[data-pad-ammo]")).toBeHidden();
      await expect(padPage.locator("[data-pad-lives]")).toBeHidden();
      await expect(padPage.locator("[data-pad-reload]")).toBeHidden();
      await expect(padPage.locator("[data-pad-draw]")).toBeVisible();
      await expect(padPage.locator("[data-pad-draw-pct]")).toHaveText("READY");
      await expect(padPage.locator("[data-gesture-readout]")).toContainText("Hold=Draw");

      // Hold phone touch surface to draw bowstring -> release to loose arrow on End 1
      await hostPage.locator("[data-toggle-debug]").click();
      const surface = padPage.locator("[data-pad-surface]");
      const sBox = await surface.boundingBox();
      if (!sBox) throw new Error("Missing pad surface bounding box");
      await padPage.mouse.move(sBox.x + sBox.width * 0.5, sBox.y + sBox.height * 0.5);
      await padPage.mouse.down();
      await expect(padPage.locator("[data-pad-draw-pct]")).toContainText("%", { timeout: 2_500 });
      await padPage.waitForTimeout(380);
      await padPage.mouse.up();
      await expect(hostPage.locator(".debug-drawer")).toContainText("Last gesture: P1 · hold_end");

      // After arrow impacts single target and camera completes inspect glide, End 2/6 begins cleanly
      await expect(hostPage.locator("[data-hud-timer]")).toHaveText("End 2/6", { timeout: 6_000 });
      await expect(
        hostPage.locator('[data-hud-scoreboard] .attempt-box:not([data-state="pending"])'),
      ).toHaveCount(1);

      await hostPage.locator("[data-stage-finish]").click();
      await expect(hostPage.getByRole("heading", { name: /Archery Results/i })).toBeVisible();
      await expect(hostPage.locator(".results-list")).toContainText("RobinHood");
      await expect(hostPage.locator("[data-result-card-img]")).toHaveAttribute(
        "src",
        /^data:image\/png;base64,/,
      );
    } finally {
      await padContext.close();
      await hostContext.close();
    }
  });

  test("plays Archery in Simulator mode with Chill preset, draw-and-release, and Space loose", async ({
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
      await page.locator('[data-set-difficulty="casual"]').click();

      await page.locator("[data-play-archery]").click();
      await expect(page.locator("[data-countdown-banner]")).toBeVisible();
      await expect(page.locator("[data-countdown-banner]")).toBeHidden({ timeout: 6_000 });
      await expect(page.locator("[data-hud-difficulty]")).toHaveText("Chill");
      await expect(page.locator("[data-hud-wind]")).toBeVisible();
      await expect(page.locator("[data-hud-timer]")).toHaveText("End 1/6");

      const canvas = page.locator("canvas.host-stage-canvas");
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Missing stage canvas bounding box");

      // Aim towards center range target, hold left mouse to draw bow, then release
      await page.locator("[data-toggle-debug]").click();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.48);
      await page.mouse.down();
      await page.waitForTimeout(520);
      await page.mouse.up();
      await expect(page.locator(".debug-drawer")).toContainText("Last gesture: P1 · hold_end");

      // Wait seamlessly into End 2/6 after camera inspect glide
      await expect(page.locator("[data-hud-timer]")).toHaveText("End 2/6", { timeout: 6_000 });
      await expect(
        page.locator('[data-hud-scoreboard] .attempt-box:not([data-state="pending"])'),
      ).toHaveCount(1);
      await page.waitForTimeout(950);

      // Space bar quick-shot looses on End 2 and advances to End 3/6
      await page.keyboard.press("Space");
      await expect(page.locator(".debug-drawer")).toContainText("Last gesture: P1 · swing");
      await expect(page.locator("[data-hud-timer]")).toHaveText("End 3/6", { timeout: 6_000 });

      await page.locator("[data-stage-finish]").click();
      await expect(page.getByRole("heading", { name: /Archery Results/i })).toBeVisible();
      await expect(page.locator("[data-download-card]")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
