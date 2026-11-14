import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./pad.css";
import {
  clamp,
  DEFAULT_DEADZONE_DEG,
  DEFAULT_SENSITIVITY,
  GAME_CATALOG,
  INPUT_FLAG_CALIBRATED,
  INPUT_FLAG_PRIMARY,
  INPUT_FLAG_SECONDARY,
  INPUT_FLAG_SIMULATOR,
  INPUT_SEND_INTERVAL_MS,
  PLAYER_AVATARS,
  ROOM_CODE_LENGTH,
  type AvatarId,
  type CalibrationStep,
  type PartyRoomStateSnapshot,
  type PlayerSlotState,
} from "@gyro/shared";
import { avatarSvg, ICON_RECENTER } from "../common/avatars.js";
import { bindThemeToggle, themeToggleHtml } from "../common/theme.js";
import { PadClient } from "./net/PadClient.js";
import { acquireWakeLock, lockPortraitOrientation, triggerHaptic } from "./pwa/ergonomics.js";
import { GestureDetector } from "./sensors/gestures.js";
import { GyroControllerPipeline } from "./sensors/orientation.js";

const PREFS_KEY = "gyro-pad-prefs";

interface LocalPrefs {
  name: string;
  avatarId: AvatarId;
  sensitivity: number;
  deadZoneDeg: number;
}

function loadPrefs(): LocalPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalPrefs>;
      return {
        name: typeof parsed.name === "string" ? parsed.name.slice(0, 16) : "",
        avatarId: PLAYER_AVATARS.includes(parsed.avatarId as AvatarId)
          ? (parsed.avatarId as AvatarId)
          : "crosshair",
        sensitivity: clamp(Number(parsed.sensitivity ?? DEFAULT_SENSITIVITY), 0.5, 2.5),
        deadZoneDeg: clamp(Number(parsed.deadZoneDeg ?? DEFAULT_DEADZONE_DEG), 0, 5),
      };
    }
  } catch {
    // ignore
  }
  return {
    name: "",
    avatarId: "crosshair",
    sensitivity: DEFAULT_SENSITIVITY,
    deadZoneDeg: DEFAULT_DEADZONE_DEG,
  };
}

function savePrefs(prefs: LocalPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

class PadApp {
  private readonly root: HTMLElement;
  private readonly pipeline = new GyroControllerPipeline();
  private prefs = loadPrefs();
  private roomState: PartyRoomStateSnapshot | null = null;
  private mySlot = -1;
  private connStatus: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" = "idle";
  private statusText = "";
  private errorMessage = "";
  private rttMs = 0;

  private sensorReady = false;
  private sensorDenied = false;
  private calibStep: CalibrationStep = "pending";
  private stillProgress = 0;
  private rangeYawDeg = 0;
  private rangePitchDeg = 0;
  private rangePassed = false;
  private stillError = "";

  private gestureSeq = 0;
  private lastGestureText = "Tap, hold, swipe, or flick";
  private lastGestureTs = 0;
  private lastGesturePower = 0;

  private rafId: number | null = null;
  private lastSendTs = 0;
  private stillTimerId: number | null = null;
  private padDetach: (() => void) | null = null;

  private readonly padClient: PadClient;
  private readonly gestureDetector: GestureDetector;

  constructor(root: HTMLElement) {
    this.root = root;
    this.pipeline.setPreferences(this.prefs.sensitivity, this.prefs.deadZoneDeg);

    this.gestureDetector = new GestureDetector((g) => {
      this.gestureSeq += 1;
      this.lastGestureText = `${g.kind.toUpperCase()} (${g.power.toFixed(1)})`;
      this.lastGestureTs = performance.now();
      this.lastGesturePower = g.power;

      if (g.kind === "tap" || g.kind === "swipe" || g.kind === "flick" || g.kind === "swing") {
        triggerHaptic("tap");
      }

      this.padClient.sendControl({
        type: "pad:gesture",
        seq: this.gestureSeq,
        kind: g.kind,
        dx: g.dx,
        dy: g.dy,
        power: g.power,
        clientTs: g.clientTs,
      });

      const labelEl = this.root.querySelector("[data-gesture-readout]");
      if (labelEl) labelEl.textContent = this.lastGestureText;
    });

    this.pipeline.onMotionSample((angVel, accelMag, ax, ay, az, ts) => {
      if (this.calibStep === "done" || this.roomState?.phase === "playing") {
        this.gestureDetector.pushMotionSample(angVel, accelMag, ax, ay, az, ts);
      }
    });

    this.padClient = new PadClient({
      onState: (state, slot) => {
        const prevPhase = this.roomState?.phase;
        const prevMe = this.getMe();
        this.roomState = state;
        this.mySlot = slot;
        const me = this.getMe();
        if (me) {
          this.root.style.setProperty("--player-color", me.colorHex);
        }
        const identityChanged =
          me !== undefined &&
          (!prevMe || prevMe.slot !== me.slot || prevMe.name !== me.name || prevMe.colorHex !== me.colorHex);

        if (state.phase === "calibration" && prevPhase !== "calibration") {
          this.calibStep = "still";
          this.startStillCalibration();
        } else if (prevPhase !== state.phase || identityChanged || !this.root.querySelector("[data-pad-surface]")) {
          this.render();
        } else {
          this.updateLiveHeaderAndStatus();
        }
      },
      onStatus: (status, detail) => {
        this.connStatus = status;
        this.statusText = detail ?? "";
        this.render();
      },
      onHaptic: (pattern) => {
        triggerHaptic(pattern);
      },
      onRtt: (rtt) => {
        this.rttMs = rtt;
        const rttEl = this.root.querySelector("[data-rtt]");
        if (rttEl) rttEl.textContent = `${rtt} ms`;
      },
      onError: (msg) => {
        this.errorMessage = msg;
        this.render();
      },
    });
  }

  async boot(): Promise<void> {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get("room")?.trim().toUpperCase() ?? "";
    const saved = this.padClient.loadSavedSession();

    if (saved && (!urlRoom || saved.roomCode === urlRoom)) {
      const ok = await this.padClient.tryReconnectSaved();
      if (ok) {
        await this.tryResumeSensorsWithoutPrompt();
        return;
      }
    }

    this.render();
  }

  private async tryResumeSensorsWithoutPrompt(): Promise<void> {
    if (this.pipeline.getPermissionState() === "granted") {
      await this.pipeline.startSensors();
      this.sensorReady = true;
      this.startSendLoop();
    }
    this.render();
  }

  private getMe(): PlayerSlotState | undefined {
    return this.roomState?.players.find((p) => p.slot === this.mySlot);
  }

  private async handleJoinSubmit(code: string, name: string, avatarId: AvatarId): Promise<void> {
    this.errorMessage = "";
    this.prefs.name = name;
    this.prefs.avatarId = avatarId;
    savePrefs(this.prefs);

    // Request iOS sensor permission directly inside user submit tap if needed!
    const permRes = await this.pipeline.requestPermissionsAndStart();
    this.sensorReady = true;
    this.sensorDenied = !permRes.granted;

    void acquireWakeLock();
    void lockPortraitOrientation();

    try {
      await this.padClient.joinRoom(code, name || "Player", avatarId);
      this.padClient.sendControl({
        type: "pad:prefs",
        sensitivity: this.prefs.sensitivity,
        deadZoneDeg: this.prefs.deadZoneDeg,
      });
      this.startSendLoop();
    } catch {
      // Error surfaced via PadClient onError
    }
  }

  private async handleEnableMotionTap(): Promise<void> {
    const res = await this.pipeline.requestPermissionsAndStart();
    this.sensorReady = true;
    this.sensorDenied = !res.granted;
    void acquireWakeLock();
    void lockPortraitOrientation();
    this.startSendLoop();
    this.render();
  }

  private startStillCalibration(): void {
    if (this.stillTimerId !== null) window.clearInterval(this.stillTimerId);
    this.calibStep = "still";
    this.stillProgress = 0;
    this.stillError = "";
    this.pipeline.markCalibrated(false);
    this.pipeline.beginStillCalibration();
    this.padClient.sendControl({ type: "pad:calibration", step: "still", ok: false });
    this.render();

    const startedAt = performance.now();
    const durationMs = 1400;
    this.stillTimerId = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      this.stillProgress = Math.min(100, Math.round((elapsed / durationMs) * 100));
      const fill = this.root.querySelector<HTMLElement>("[data-still-fill]");
      if (fill) fill.style.inlineSize = `${this.stillProgress}%`;

      if (elapsed >= durationMs) {
        if (this.stillTimerId !== null) {
          window.clearInterval(this.stillTimerId);
          this.stillTimerId = null;
        }
        const summary = this.pipeline.finishStillCalibration();
        if (!summary.passed) {
          this.stillError = "Phone moved during baseline check. Hold steady on a flat hand and retry.";
          triggerHaptic("error");
          this.render();
          return;
        }
        this.gestureDetector.calibrateFromNoise(summary.noiseFloorRad * (180 / Math.PI));
        this.calibStep = "center";
        this.padClient.sendControl({
          type: "pad:calibration",
          step: "center",
          ok: true,
          noiseFloor: summary.noiseFloorRad,
        });
        triggerHaptic("hit");
        this.render();
      }
    }, 50);
  }

  private handleLockCenter(): void {
    this.pipeline.captureCenterAndStartRange();
    this.calibStep = "range";
    this.rangeYawDeg = 0;
    this.rangePitchDeg = 0;
    this.rangePassed = false;
    this.padClient.sendControl({ type: "pad:calibration", step: "range", ok: false });
    triggerHaptic("tap");
    this.render();
  }

  private handleFinishCalibration(): void {
    this.pipeline.markCalibrated(true);
    this.calibStep = "done";
    this.padClient.sendControl({ type: "pad:calibration", step: "done", ok: true });
    this.padClient.sendControl({ type: "pad:ready", ready: true });
    triggerHaptic("combo");
    this.render();
  }

  private handleRecenter(): void {
    this.pipeline.recenter();
    this.padClient.sendControl({ type: "pad:recenter" });
    triggerHaptic("tap");
    const status = this.root.querySelector("[data-recenter-toast]");
    if (status) {
      status.textContent = "Recentered";
      window.setTimeout(() => {
        if (status) status.textContent = "";
      }, 900);
    }
  }

  private startSendLoop(): void {
    if (this.rafId !== null) return;
    const tick = (now: number) => {
      this.rafId = window.requestAnimationFrame(tick);

      if (now - this.lastSendTs >= INPUT_SEND_INTERVAL_MS) {
        this.lastSendTs = now;
        const pose = this.pipeline.sampleAim(now);
        const holding = this.gestureDetector.isHolding();
        const isTouchFallback = this.pipeline.getBackend() === "touch-fallback";

        let flags = 0;
        if (holding) flags |= INPUT_FLAG_PRIMARY;
        if (this.pipeline.isCalibrated()) flags |= INPUT_FLAG_CALIBRATED;
        if (isTouchFallback) flags |= INPUT_FLAG_SIMULATOR;
        if (now - this.lastGestureTs < 120) flags |= INPUT_FLAG_SECONDARY;

        const gesturePower = now - this.lastGestureTs < 150 ? this.lastGesturePower : 0;
        this.padClient.sendInputFrame(
          pose.yaw,
          pose.pitch,
          pose.roll,
          this.pipeline.getAngVelMag(),
          gesturePower,
          flags,
        );

        this.drawAimPreview(pose.yaw, pose.pitch);

        if (this.calibStep === "range") {
          const range = this.pipeline.pollRangeCheck();
          this.rangeYawDeg = Math.round(range.spanYawDeg);
          this.rangePitchDeg = Math.round(range.spanPitchDeg);
          const spanEl = this.root.querySelector("[data-range-readout]");
          if (spanEl) {
            spanEl.textContent = `Yaw ${this.rangeYawDeg}° / 18° · Pitch ${this.rangePitchDeg}° / 12°`;
          }
          if (range.passed && !this.rangePassed) {
            this.rangePassed = true;
            triggerHaptic("hit");
            const finishBtn = this.root.querySelector<HTMLButtonElement>("[data-finish-calib]");
            if (finishBtn) finishBtn.disabled = false;
          }
        }
      }
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private drawAimPreview(yawRad: number, pitchRad: number): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>("canvas.aim-preview");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    // Subtle crosshair guide
    ctx.strokeStyle = "rgba(165, 176, 194, 0.22)";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const nx = clamp(yawRad / 0.65, -1, 1);
    const ny = clamp(-pitchRad / 0.45, -1, 1);
    const px = w * 0.5 + nx * (w * 0.42);
    const py = h * 0.5 + ny * (h * 0.42);

    const me = this.getMe();
    const color = me?.colorHex ?? "#FF4D2E";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, 10 * dpr, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#F1F4F9";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, 16 * dpr, 0, Math.PI * 2);
    ctx.stroke();
  }

  private updateLiveHeaderAndStatus(): void {
    const me = this.getMe();
    const scoreEl = this.root.querySelector("[data-my-score]");
    if (scoreEl && me) scoreEl.textContent = `${me.score} pts`;
    const phaseEl = this.root.querySelector("[data-room-phase]");
    if (phaseEl && this.roomState) {
      const game = GAME_CATALOG.find((g) => g.id === this.roomState?.selectedGame);
      phaseEl.textContent = `${game?.title ?? this.roomState.selectedGame} · ${this.roomState.phase}`;
    }
  }

  private render(): void {
    if (this.padDetach) {
      this.padDetach();
      this.padDetach = null;
    }

    const me = this.getMe();
    const inRoom = Boolean(this.roomState && this.connStatus !== "disconnected");
    const params = new URLSearchParams(window.location.search);
    const prefillCode = (params.get("room") ?? "").toUpperCase().slice(0, ROOM_CODE_LENGTH);

    this.root.innerHTML = `
      <div class="pad-shell">
        <header class="pad-topbar">
          <div class="pad-brand">
            ${
              me
                ? `<span class="slot-badge"><span class="slot-dot"></span><span>P${me.slot + 1} · ${escapeHtml(me.name)}</span></span>`
                : `<span>Gyro-Gamezone</span>`
            }
          </div>
          <div class="pad-actions">
            ${inRoom ? `<span class="status-pill" data-rtt>${this.rttMs} ms</span>` : ""}
            <button type="button" class="btn btn-ghost" data-open-settings aria-label="Controller settings">Tune</button>
            ${themeToggleHtml()}
          </div>
        </header>

        <main class="pad-main">
          ${this.errorMessage ? `<div class="banner banner-error" role="alert">${escapeHtml(this.errorMessage)}</div>` : ""}
          ${this.connStatus === "reconnecting" ? `<div class="banner banner-warn" role="status">${escapeHtml(this.statusText || "Reconnecting…")}</div>` : ""}
          ${!inRoom ? this.renderJoinView(prefillCode) : this.renderControllerView(me)}
        </main>
      </div>

      <dialog id="pad-settings-dialog" aria-labelledby="pad-settings-title" closedby="any">
        <h2 id="pad-settings-title">Controller Tuning</h2>
        <p class="field-hint" style="margin-block: 8px 16px;">Adjust aim speed and dead zone for your wrist comfort.</p>
        <div class="slider-row">
          <div class="slider-row-head">
            <label for="sens-range">Aim Sensitivity</label>
            <span class="mono" data-sens-val>${this.prefs.sensitivity.toFixed(2)}x</span>
          </div>
          <input id="sens-range" type="range" min="0.5" max="2.5" step="0.05" value="${this.prefs.sensitivity}" />
        </div>
        <div class="slider-row">
          <div class="slider-row-head">
            <label for="dz-range">Dead Zone</label>
            <span class="mono" data-dz-val>${this.prefs.deadZoneDeg.toFixed(1)}°</span>
          </div>
          <input id="dz-range" type="range" min="0" max="5" step="0.1" value="${this.prefs.deadZoneDeg}" />
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:16px;">
          <a class="btn btn-ghost" href="/pad/debug">Open Sensor Lab</a>
          <button type="button" class="btn btn-primary" data-close-settings>Done</button>
        </div>
      </dialog>
    `;

    const themeBtn = this.root.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    if (themeBtn) bindThemeToggle(themeBtn);
    this.bindSettingsDialog();

    if (!inRoom) {
      this.bindJoinForm();
    } else {
      this.bindControllerEvents();
    }
  }

  private renderJoinView(prefillCode: string): string {
    return `
      <section class="panel">
        <h1>Join Room</h1>
        <p class="field-hint" style="margin-block: 6px 16px;">Enter the 4-character code shown on the desktop screen.</p>
        <form class="join-form" data-join-form novalidate>
          <div class="field">
            <label for="room-code">Room code <span aria-hidden="true">*</span></label>
            <span id="room-code-hint" class="field-hint">4 letters or numbers from the host lobby.</span>
            <input
              id="room-code"
              name="roomCode"
              class="room-code-input"
              type="text"
              value="${escapeHtml(prefillCode)}"
              maxlength="4"
              minlength="4"
              pattern="[A-Za-z0-9]{4}"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="characters"
              spellcheck="false"
              enterkeyhint="next"
              aria-describedby="room-code-hint room-code-err"
              required
            />
            <span id="room-code-err" class="field-error" aria-live="polite"></span>
          </div>

          <div class="field">
            <label for="player-name">Display name <span aria-hidden="true">*</span></label>
            <input
              id="player-name"
              name="playerName"
              type="text"
              value="${escapeHtml(this.prefs.name)}"
              maxlength="16"
              autocomplete="nickname"
              enterkeyhint="done"
              aria-describedby="player-name-err"
              required
            />
            <span id="player-name-err" class="field-error" aria-live="polite"></span>
          </div>

          <fieldset class="avatar-fieldset">
            <legend>Controller emblem</legend>
            <div class="avatar-grid">
              ${PLAYER_AVATARS.map(
                (id) => `
                  <label class="avatar-option">
                    <input
                      type="radio"
                      name="avatarId"
                      value="${id}"
                      class="visually-hidden"
                      ${this.prefs.avatarId === id ? "checked" : ""}
                    />
                    ${avatarSvg(id, "currentColor", 24)}
                    <span>${id}</span>
                  </label>
                `,
              ).join("")}
            </div>
          </fieldset>

          <button type="submit" class="btn btn-primary" ${this.connStatus === "connecting" ? "disabled" : ""}>
            ${this.connStatus === "connecting" ? "Connecting…" : "Join & Enable Motion"}
          </button>
        </form>
        <div style="margin-block-start: 16px; display: flex; justify-content: space-between; align-items: center;">
          <span class="field-hint">Sensor check before playing?</span>
          <a class="btn btn-ghost" href="/pad/debug">Sensor Lab</a>
        </div>
      </section>
    `;
  }

  private renderControllerView(me?: PlayerSlotState): string {
    const state = this.roomState!;
    const game = GAME_CATALOG.find((g) => g.id === state.selectedGame);
    const needsMotionPrompt =
      !this.sensorReady && this.pipeline.getPermissionState() === "prompt";

    if (needsMotionPrompt) {
      return `
        <section class="panel" style="display:flex;flex-direction:column;gap:14px;">
          <h2>Motion Sensor Access</h2>
          <p class="field-hint">iOS requires a tap to unlock the gyroscope and accelerometer for aiming.</p>
          <button type="button" class="btn btn-accent" data-enable-motion>Enable Gyro & Motion</button>
        </section>
      `;
    }

    const sensorNotice = this.sensorDenied
      ? `<div class="banner banner-warn">Motion permission denied. Touch-drag fallback active — to re-enable gyro on iOS Safari, open Settings → Safari → Motion &amp; Orientation Access and reload.</div>`
      : this.pipeline.getBackend() === "touch-fallback"
        ? `<div class="banner">No hardware gyro detected — drag on the pad to aim.</div>`
        : "";

    if (state.phase === "calibration" || this.calibStep === "still" || this.calibStep === "center" || this.calibStep === "range") {
      return `
        ${sensorNotice}
        <section class="panel" style="display:flex;flex-direction:column;gap:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h2>Calibration</h2>
            <span class="status-pill">${this.pipeline.getBackend()}</span>
          </div>
          <div class="calib-steps">
            <div class="calib-chip ${this.calibStep === "still" ? "is-active" : this.calibStep === "center" || this.calibStep === "range" || this.calibStep === "done" ? "is-done" : ""}">1. Hold Still</div>
            <div class="calib-chip ${this.calibStep === "center" ? "is-active" : this.calibStep === "range" || this.calibStep === "done" ? "is-done" : ""}">2. Center</div>
            <div class="calib-chip ${this.calibStep === "range" ? "is-active" : this.calibStep === "done" ? "is-done" : ""}">3. Range</div>
          </div>

          ${
            this.calibStep === "still"
              ? `
                <p>Keep your phone steady for 1.5 seconds so we measure sensor drift.</p>
                <div class="progress-bar"><div class="progress-fill" data-still-fill style="inline-size:${this.stillProgress}%"></div></div>
                ${this.stillError ? `<div class="banner banner-error">${escapeHtml(this.stillError)}</div><button type="button" class="btn btn-primary" data-retry-still>Retry Still Check</button>` : ""}
              `
              : this.calibStep === "center"
                ? `
                  <p>Hold your phone naturally pointing toward the center of the desktop screen, then tap Lock Center.</p>
                  <button type="button" class="btn btn-accent" data-lock-center>Lock Center Pose</button>
                `
                : this.calibStep === "range"
                  ? `
                    <p>Sweep smoothly left/right and up/down to verify your full aiming range.</p>
                    <p class="mono" data-range-readout>Yaw ${this.rangeYawDeg}° / 18° · Pitch ${this.rangePitchDeg}° / 12°</p>
                    <div class="pad-surface" data-pad-surface style="min-block-size: 160px;">
                      <canvas class="aim-preview"></canvas>
                      <div class="pad-surface-label"><span class="field-hint">Live aim preview</span></div>
                    </div>
                    <button type="button" class="btn btn-primary" data-finish-calib ${this.rangePassed ? "" : "disabled"}>
                      Finish Calibration
                    </button>
                    <button type="button" class="btn btn-ghost" data-skip-range>Skip Check &amp; Continue</button>
                  `
                  : `
                    <p>Calibrated and ready! Waiting for the host to start.</p>
                    <button type="button" class="btn btn-ghost" data-recalibrate>Re-run Calibration</button>
                  `
          }
        </section>
      `;
    }

    return `
      ${sensorNotice}
      <div style="display:flex;justify-content:space-between;align-items:center;padding-inline:4px;">
        <span class="field-hint" data-room-phase>${escapeHtml(game?.title ?? state.selectedGame)} · ${state.phase}</span>
        <span class="mono" data-my-score>${me ? `${me.score} pts` : ""}</span>
      </div>

      <div class="pad-surface" data-pad-surface tabindex="0" aria-label="Interactive controller touch pad">
        <canvas class="aim-preview"></canvas>
        <div class="pad-surface-label">
          <strong>${state.phase === "lobby" ? "Connected to Room " + escapeHtml(state.roomCode) : "Active Controller"}</strong>
          <span class="field-hint" data-gesture-readout>${escapeHtml(this.lastGestureText)}</span>
        </div>
      </div>

      <div class="pad-footer">
        <button type="button" class="btn btn-primary" data-recenter>
          ${ICON_RECENTER}
          <span>Recenter</span>
          <span class="field-hint" data-recenter-toast></span>
        </button>
        <button type="button" class="btn btn-ghost" data-start-calib>Calibrate</button>
        <button type="button" class="btn btn-ghost" data-leave-room>Leave</button>
      </div>
    `;
  }

  private bindJoinForm(): void {
    const form = this.root.querySelector<HTMLFormElement>("[data-join-form]");
    const codeInput = this.root.querySelector<HTMLInputElement>("#room-code");
    const nameInput = this.root.querySelector<HTMLInputElement>("#player-name");
    const codeErr = this.root.querySelector<HTMLElement>("#room-code-err");
    const nameErr = this.root.querySelector<HTMLElement>("#player-name-err");
    if (!form || !codeInput || !nameInput) return;

    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      codeInput.setCustomValidity("");
      if (codeErr) codeErr.textContent = "";
    });
    nameInput.addEventListener("input", () => {
      nameInput.setCustomValidity("");
      if (nameErr) nameErr.textContent = "";
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = codeInput.value.trim().toUpperCase();
      const name = nameInput.value.trim();

      if (code.length !== ROOM_CODE_LENGTH) {
        const msg = "Enter the 4-character room code shown on the desktop screen.";
        codeInput.setCustomValidity(msg);
        if (codeErr) codeErr.textContent = msg;
        codeInput.focus();
        return;
      }
      if (!name) {
        const msg = "Enter a short display name.";
        nameInput.setCustomValidity(msg);
        if (nameErr) nameErr.textContent = msg;
        nameInput.focus();
        return;
      }

      const checked = form.querySelector<HTMLInputElement>('input[name="avatarId"]:checked');
      const avatarId = (checked?.value ?? "crosshair") as AvatarId;
      void this.handleJoinSubmit(code, name, avatarId);
    });
  }

  private bindControllerEvents(): void {
    this.root.querySelector("[data-enable-motion]")?.addEventListener("click", () => {
      void this.handleEnableMotionTap();
    });
    this.root.querySelector("[data-retry-still]")?.addEventListener("click", () => {
      this.startStillCalibration();
    });
    this.root.querySelector("[data-lock-center]")?.addEventListener("click", () => {
      this.handleLockCenter();
    });
    this.root.querySelector("[data-finish-calib]")?.addEventListener("click", () => {
      this.handleFinishCalibration();
    });
    this.root.querySelector("[data-skip-range]")?.addEventListener("click", () => {
      this.handleFinishCalibration();
    });
    this.root.querySelector("[data-recalibrate]")?.addEventListener("click", () => {
      this.startStillCalibration();
    });
    this.root.querySelector("[data-start-calib]")?.addEventListener("click", () => {
      this.startStillCalibration();
    });
    this.root.querySelector("[data-recenter]")?.addEventListener("click", () => {
      this.handleRecenter();
    });
    this.root.querySelector("[data-leave-room]")?.addEventListener("click", () => {
      void this.padClient.leave().then(() => {
        this.roomState = null;
        this.connStatus = "idle";
        this.render();
      });
    });

    const surface = this.root.querySelector<HTMLElement>("[data-pad-surface]");
    if (surface) {
      this.padDetach = this.gestureDetector.attachPadSurface(surface, (dx, dy) => {
        if (this.pipeline.getBackend() === "touch-fallback") {
          this.pipeline.nudgeTouchAim(dx, dy);
        }
      });
      surface.addEventListener("pointerdown", () => surface.classList.add("is-pressed"));
      surface.addEventListener("pointerup", () => surface.classList.remove("is-pressed"));
      surface.addEventListener("pointercancel", () => surface.classList.remove("is-pressed"));
    }
  }

  private bindSettingsDialog(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>("#pad-settings-dialog");
    const openBtn = this.root.querySelector("[data-open-settings]");
    const closeBtn = this.root.querySelector("[data-close-settings]");
    const sensRange = this.root.querySelector<HTMLInputElement>("#sens-range");
    const dzRange = this.root.querySelector<HTMLInputElement>("#dz-range");
    const sensVal = this.root.querySelector("[data-sens-val]");
    const dzVal = this.root.querySelector("[data-dz-val]");

    if (!dialog) return;

    openBtn?.addEventListener("click", () => dialog.showModal());
    closeBtn?.addEventListener("click", () => dialog.close());

    // Fallback light-dismiss for Safari (lacks closedby)
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let downOutside = false;
      const isOut = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      dialog.addEventListener("pointerdown", (e) => {
        downOutside = isOut(e);
      });
      dialog.addEventListener("pointerup", (e) => {
        if (downOutside && isOut(e)) dialog.close();
      });
    }

    sensRange?.addEventListener("input", () => {
      this.prefs.sensitivity = Number(sensRange.value);
      if (sensVal) sensVal.textContent = `${this.prefs.sensitivity.toFixed(2)}x`;
      this.pipeline.setPreferences(this.prefs.sensitivity, this.prefs.deadZoneDeg);
      savePrefs(this.prefs);
      this.padClient.sendControl({
        type: "pad:prefs",
        sensitivity: this.prefs.sensitivity,
        deadZoneDeg: this.prefs.deadZoneDeg,
      });
    });

    dzRange?.addEventListener("input", () => {
      this.prefs.deadZoneDeg = Number(dzRange.value);
      if (dzVal) dzVal.textContent = `${this.prefs.deadZoneDeg.toFixed(1)}°`;
      this.pipeline.setPreferences(this.prefs.sensitivity, this.prefs.deadZoneDeg);
      savePrefs(this.prefs);
      this.padClient.sendControl({
        type: "pad:prefs",
        sensitivity: this.prefs.sensitivity,
        deadZoneDeg: this.prefs.deadZoneDeg,
      });
    });
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const appRoot = document.getElementById("app")!;

window.addEventListener("error", (ev) => {
  appRoot.innerHTML = `<main class="pad-shell"><div class="panel banner banner-error"><h1>Controller Error</h1><p>${escapeHtml(ev.message)}</p><button class="btn btn-primary" onclick="location.reload()">Reload Controller</button></div></main>`;
});

const app = new PadApp(appRoot);
void app.boot();
