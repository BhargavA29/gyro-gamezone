import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./host.css";
import QRCode from "qrcode";
import {
  DIFFICULTY_PRESETS,
  GAME_CATALOG,
  MAX_PLAYERS,
  PLAYER_SLOT_PALETTE,
  RECONNECT_GRACE_MS,
  type DifficultyPreset,
  type GameHostContext,
  type GameId,
  type GamePlugin,
  type HapticPattern,
  type PartyRoomStateSnapshot,
  type RoomPhase,
} from "@gyro/shared";
import { avatarSvg, ICON_VOLUME_OFF, ICON_VOLUME_ON } from "../common/avatars.js";
import {
  getColyseusEndpoint,
  getServerOverride,
  resolveJoinOrigin,
} from "../common/colyseus-client.js";
import { bindThemeToggle, themeToggleHtml } from "../common/theme.js";
import { AudioEngine } from "./engine/AudioEngine.js";
import { HostEngine, type EngineTelemetry } from "./engine/HostEngine.js";
import { isGameImplemented, loadGamePlugin } from "./games/registry.js";
import { HostClient } from "./net/HostClient.js";
import { renderShareableResultCard } from "./resultsCard.js";
import { InputSimulator } from "./simulator/InputSimulator.js";

const CUSTOM_ORIGIN_KEY = "gyro-host-custom-origin";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function calibrationStepLabel(step: string, calibrated: boolean): string {
  if (calibrated || step === "done") return "Calibrated";
  switch (step) {
    case "still":
      return "1/3 Hold still";
    case "center":
      return "2/3 Point center";
    case "range":
      return "3/3 Range sweep";
    default:
      return "Waiting to start";
  }
}

type ScreenKind = "loading" | "error" | "lobby" | "game_select" | "stage" | "results";

class HostApp {
  private readonly root: HTMLElement;
  private readonly audio = new AudioEngine();
  private readonly hostClient: HostClient;
  private readonly engine: HostEngine;
  private readonly simulator: InputSimulator;

  private roomState: PartyRoomStateSnapshot | null = null;
  private connStatus: "connecting" | "connected" | "reconnecting" | "disconnected" = "connecting";
  private errorBanner: string | null = null;
  private fatalError: string | null = null;

  private currentScreen: ScreenKind = "loading";
  private lastRoomPhase: RoomPhase | null = null;
  private activePlugin: GamePlugin | null = null;
  private activeGameLoadedId: GameId | null = null;
  private stageMountEl: HTMLElement | null = null;
  private stageResizeObserver: ResizeObserver | null = null;

  private customOrigin = this.readCustomOrigin();
  private qrDataUrl = "";
  private qrTargetUrl = "";
  private copiedFlash = false;

  private simActive = false;
  private simSlot = -1;
  private showDebug = false;
  private rttMs = 0;
  private telemetry: EngineTelemetry = {
    fps: 60,
    frameMs: 16.6,
    renderScale: 1.0,
    effectiveDpr: 1,
  };
  private lastGestureText = "None yet";
  private playerAmmoState = new Map<
    number,
    { ammo: number; maxAmmo: number; reloading: boolean; streak: number }
  >();
  private latestScoreboard: Array<{
    slot: number;
    name: string;
    colorHex: string;
    score: number;
    lives?: number;
    maxLives?: number;
    attempts?: ReadonlyArray<number | null>;
  }> = [];

  private announceText = "";
  private announceTimer: number | null = null;
  private countdownTickTimer: number | null = null;
  private reconnectUiTimer: number | null = null;
  private debugRefreshTimer: number | null = null;
  private detachTheme: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.hostClient = new HostClient({
      onState: (state) => {
        this.roomState = state;
        void this.syncScreenFromState();
      },
      onGesture: (ev) => {
        this.lastGestureText = `P${ev.slot + 1} · ${ev.kind} (${ev.power.toFixed(2)})`;
        this.engine.forwardGesture(ev);
      },
      onRecenter: (slot) => {
        const plugin = this.activePlugin as { triggerRecenterFeedback?: (s: number) => void } | null;
        plugin?.triggerRecenterFeedback?.(slot);
        this.lastGestureText = `P${slot + 1} · recenter`;
      },
      onRtt: (ms) => {
        this.rttMs = ms;
        const el = this.root.querySelector("[data-rtt-badge]");
        if (el) el.textContent = `${ms} ms`;
      },
      onStatus: (status) => {
        this.connStatus = status;
        this.patchTopbarStatus();
      },
      onError: (msg) => {
        this.errorBanner = msg;
        this.renderErrorBanner();
      },
    });

    this.engine = new HostEngine(
      this.hostClient.inputBuffer,
      () => this.roomState,
      (_scale, effectiveDpr) => {
        if (this.stageMountEl && this.activePlugin?.onResize) {
          this.activePlugin.onResize(
            this.stageMountEl.clientWidth,
            this.stageMountEl.clientHeight,
            effectiveDpr,
          );
        }
      },
      (t) => {
        this.telemetry = t;
        if (this.showDebug) this.patchDebugDrawer();
      },
    );

    this.simulator = new InputSimulator((active, slot) => {
      this.simActive = active;
      this.simSlot = slot;
      this.patchTopbarStatus();
    });

    this.attachGlobalErrorBoundary();
    this.attachShortcuts();
    this.renderShellSkeleton();
    void this.connectAndCreateRoom();

    this.reconnectUiTimer = window.setInterval(() => {
      if (this.currentScreen === "lobby" && this.roomState) {
        const hasDropping = this.roomState.players.some(
          (p) => !p.connected && p.disconnectedAt !== null,
        );
        if (hasDropping) {
          this.renderMainScreen(true);
        }
      }
    }, 500);

    this.debugRefreshTimer = window.setInterval(() => {
      if (this.showDebug) this.patchDebugDrawer();
    }, 250);
  }

  private readCustomOrigin(): string {
    try {
      return localStorage.getItem(CUSTOM_ORIGIN_KEY) ?? "";
    } catch {
      return "";
    }
  }

  private saveCustomOrigin(value: string): void {
    const clean = value.trim().replace(/\/+$/, "");
    this.customOrigin = clean;
    try {
      if (clean) {
        localStorage.setItem(CUSTOM_ORIGIN_KEY, clean);
      } else {
        localStorage.removeItem(CUSTOM_ORIGIN_KEY);
      }
    } catch {
      // ignore storage errors
    }
    this.qrTargetUrl = "";
  }

  private attachGlobalErrorBoundary(): void {
    window.addEventListener("error", (e) => {
      this.errorBanner = e.message || "Unexpected host runtime error.";
      this.renderErrorBanner();
    });
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
      this.errorBanner = `Async error: ${reason}`;
      this.renderErrorBanner();
    });
  }

  private attachShortcuts(): void {
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "d" || e.key === "D") {
        this.showDebug = !this.showDebug;
        this.renderDebugDrawer();
      }
    });
  }

  private async connectAndCreateRoom(): Promise<void> {
    this.fatalError = null;
    this.errorBanner = null;
    this.currentScreen = "loading";
    this.renderMainScreen(true);

    try {
      this.roomState = await this.hostClient.createRoom();
      await this.syncScreenFromState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not connect to game server.";
      this.fatalError = msg;
      this.currentScreen = "error";
      this.renderMainScreen(true);
    }
  }

  private renderShellSkeleton(): void {
    this.detachTheme?.();
    this.root.innerHTML = `
      <div class="host-shell">
        <header class="host-topbar" data-no-sim>
          <div class="host-brand-group">
            <div class="host-brand">
              <span class="host-brand-mark" aria-hidden="true">G</span>
              <span>Gyro-Gamezone</span>
            </div>
            <span class="room-code-chip" data-room-chip>----</span>
            <span class="status-pill">
              <span class="status-dot" data-status-dot data-state="connecting"></span>
              <span data-status-label>Connecting</span>
              <span class="mono" data-rtt-badge>-- ms</span>
            </span>
          </div>
          <div class="host-actions">
            <button type="button" class="btn" data-toggle-sim>Simulator</button>
            <button type="button" class="btn btn-ghost" data-open-origin>Network URL</button>
            <button type="button" class="btn btn-ghost" data-toggle-debug aria-pressed="false">Debug [D]</button>
            <button type="button" class="btn btn-ghost" data-toggle-audio aria-label="Toggle sound effects">${
              this.audio.isMuted() ? ICON_VOLUME_OFF : ICON_VOLUME_ON
            }</button>
            ${themeToggleHtml()}
          </div>
        </header>

        <div data-error-slot></div>
        <main class="host-view" data-main-view></main>
      </div>

      <div data-debug-slot></div>

      <dialog data-origin-dialog closedby="any" aria-labelledby="origin-dialog-title">
        <form method="dialog" class="dialog-form" data-origin-form>
          <div>
            <h2 id="origin-dialog-title">Controller QR Base URL</h2>
            <p class="field-hint">
              Default uses your LAN address on Wi-Fi. Paste an HTTPS tunnel URL (like ngrok) when testing phones on cellular or separate networks.
            </p>
          </div>
          <div class="field">
            <label for="custom-origin-input">Public HTTPS origin (leave blank for LAN default)</label>
            <input id="custom-origin-input" type="url" placeholder="https://xxxx.ngrok-free.app" value="${escapeHtml(this.customOrigin)}" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" data-reset-origin>Reset LAN</button>
            <button type="button" class="btn btn-ghost" data-close-origin>Cancel</button>
            <button type="submit" class="btn btn-primary">Save URL</button>
          </div>
        </form>
      </dialog>
    `;

    const themeBtn = this.root.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    if (themeBtn) this.detachTheme = bindThemeToggle(themeBtn);

    this.root.querySelector("[data-toggle-sim]")?.addEventListener("click", () => {
      this.audio.unlock();
      void this.toggleSimulator();
    });

    this.root.querySelector("[data-toggle-debug]")?.addEventListener("click", () => {
      this.showDebug = !this.showDebug;
      this.renderDebugDrawer();
    });

    this.root.querySelector("[data-toggle-audio]")?.addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const muted = this.audio.toggleMute();
      if (!muted) this.audio.unlock();
      btn.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    });

    const dialog = this.root.querySelector<HTMLDialogElement>("[data-origin-dialog]");
    this.root.querySelector("[data-open-origin]")?.addEventListener("click", () => {
      const input = dialog?.querySelector<HTMLInputElement>("#custom-origin-input");
      if (input) input.value = this.customOrigin;
      dialog?.showModal();
    });

    // Backdrop click using pointer coordinates (dialog includes its own padding area)
    dialog?.addEventListener("click", (e) => {
      const rect = dialog.getBoundingClientRect();
      const outside =
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom;
      if (outside) dialog.close();
    });

    dialog?.querySelector("[data-close-origin]")?.addEventListener("click", () => {
      dialog.close();
    });

    dialog?.querySelector("[data-reset-origin]")?.addEventListener("click", () => {
      this.saveCustomOrigin("");
      dialog.close();
      if (this.currentScreen === "lobby") void this.ensureQrGenerated();
    });

    dialog?.querySelector("[data-origin-form]")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = dialog.querySelector<HTMLInputElement>("#custom-origin-input");
      this.saveCustomOrigin(input?.value ?? "");
      dialog.close();
      if (this.currentScreen === "lobby") void this.ensureQrGenerated();
    });

    this.patchTopbarStatus();
  }

  private async toggleSimulator(): Promise<void> {
    if (!this.roomState?.roomCode) return;
    if (this.simActive) {
      await this.simulator.stop();
      return;
    }
    try {
      await this.simulator.start(this.roomState.roomCode, "Desktop Sim");
    } catch (err) {
      this.errorBanner = err instanceof Error ? err.message : "Simulator failed to join.";
      this.renderErrorBanner();
    }
  }

  private patchTopbarStatus(): void {
    const chip = this.root.querySelector("[data-room-chip]");
    if (chip) chip.textContent = this.roomState?.roomCode || "----";

    const dot = this.root.querySelector("[data-status-dot]");
    if (dot) dot.setAttribute("data-state", this.connStatus);

    const label = this.root.querySelector("[data-status-label]");
    if (label) {
      label.textContent =
        this.connStatus === "connected"
          ? "Connected"
          : this.connStatus === "reconnecting"
            ? "Reconnecting"
            : this.connStatus === "disconnected"
              ? "Disconnected"
              : "Connecting";
    }

    const simBtn = this.root.querySelector<HTMLButtonElement>("[data-toggle-sim]");
    if (simBtn) {
      simBtn.disabled = !this.roomState?.roomCode;
      simBtn.classList.toggle("btn-sim-active", this.simActive);
      simBtn.textContent = this.simActive
        ? `Stop Sim (P${this.simSlot + 1})`
        : "Simulator";
    }
  }

  private renderErrorBanner(): void {
    const slot = this.root.querySelector("[data-error-slot]");
    if (!slot) return;
    if (!this.errorBanner) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = `
      <div class="error-banner" role="alert">
        <span>${escapeHtml(this.errorBanner)}</span>
        <button type="button" class="btn btn-ghost" data-dismiss-error>Dismiss</button>
      </div>
    `;
    slot.querySelector("[data-dismiss-error]")?.addEventListener("click", () => {
      this.errorBanner = null;
      this.renderErrorBanner();
    });
  }

  private targetScreenForState(state: PartyRoomStateSnapshot): ScreenKind {
    switch (state.phase) {
      case "lobby":
        return "lobby";
      case "game_select":
        return "game_select";
      case "calibration":
      case "countdown":
      case "playing":
        return "stage";
      case "results":
        return "results";
    }
  }

  private async syncScreenFromState(): Promise<void> {
    this.patchTopbarStatus();
    if (!this.roomState) return;

    const nextScreen = this.targetScreenForState(this.roomState);
    const screenChanged = nextScreen !== this.currentScreen;
    const prevPhase = this.lastRoomPhase;
    this.lastRoomPhase = this.roomState.phase;
    this.currentScreen = nextScreen;

    if (nextScreen === "stage") {
      const desiredGame: GameId =
        this.roomState.phase === "calibration" ? "aim-demo" : this.roomState.selectedGame;
      const enteringPlayFromCalib =
        prevPhase === "calibration" && this.roomState.phase === "playing";
      const pluginChanged =
        this.activeGameLoadedId !== null && this.activeGameLoadedId !== desiredGame;

      if (prevPhase === "countdown" && this.roomState.phase === "playing") {
        this.audio.play("go");
      }

      if (screenChanged || enteringPlayFromCalib || pluginChanged || !this.stageMountEl) {
        this.teardownStage();
        this.renderMainScreen(true);
      } else {
        this.patchStageOverlay();
      }
      await this.ensurePluginMounted();
      this.updateCountdownLoop();
      return;
    }

    this.stopCountdownLoop();
    this.teardownStage();
    this.renderMainScreen(true);
    if (nextScreen === "lobby") {
      await this.ensureQrGenerated();
    }
  }

  private getJoinUrl(): string {
    const base = resolveJoinOrigin(this.customOrigin);
    const code = this.roomState?.roomCode ?? "";
    const override = getServerOverride();
    const serverParam = override ? `&server=${encodeURIComponent(override)}` : "";
    return `${base}/pad?room=${encodeURIComponent(code)}${serverParam}`;
  }

  private async ensureQrGenerated(): Promise<void> {
    if (!this.roomState?.roomCode) return;
    const url = this.getJoinUrl();
    if (url === this.qrTargetUrl && this.qrDataUrl) return;
    this.qrTargetUrl = url;
    try {
      this.qrDataUrl = await QRCode.toDataURL(url, {
        width: 220,
        margin: 1,
        color: { dark: "#111621", light: "#ffffff" },
      });
      const img = this.root.querySelector<HTMLImageElement>("[data-qr-img]");
      if (img) img.src = this.qrDataUrl;
      const urlText = this.root.querySelector("[data-join-url-text]");
      if (urlText) urlText.textContent = url;
    } catch {
      // Fallback: user still sees readable code and URL
    }
  }

  private renderMainScreen(forceRebuild: boolean): void {
    const container = this.root.querySelector<HTMLElement>("[data-main-view]");
    if (!container || !forceRebuild) return;

    if (this.currentScreen === "loading") {
      container.innerHTML = `
        <section class="panel">
          <h1>Creating room…</h1>
          <p class="field-hint">Connecting to relay server and generating your 4-character lobby code.</p>
        </section>
      `;
      return;
    }

    if (this.currentScreen === "error") {
      const endpoint = getColyseusEndpoint();
      container.innerHTML = `
        <section class="panel" style="display: grid; gap: 0.75rem;">
          <h1>Server connection failed</h1>
          <p class="field-hint">${escapeHtml(this.fatalError ?? "Unable to reach Colyseus relay server.")}</p>
          <p class="field-hint">
            Target relay: <code class="mono">${escapeHtml(endpoint)}</code>.
            If hosted on a free backend (Render/Koyeb), the first request after sleep takes ~30–50s to wake up — click Retry.
            If frontend &amp; backend are split (e.g., Vercel + Render), set <code>VITE_SERVER_URL</code> at build time or append <code>?server=https://your-server</code>.
          </p>
          <div style="margin-top: 0.25rem;">
            <button type="button" class="btn btn-primary" data-retry-connect>Retry connection</button>
          </div>
        </section>
      `;
      container.querySelector("[data-retry-connect]")?.addEventListener("click", () => {
        void this.connectAndCreateRoom();
      });
      return;
    }

    if (!this.roomState) return;

    if (this.currentScreen === "lobby") {
      this.renderLobby(container, this.roomState);
      return;
    }
    if (this.currentScreen === "game_select") {
      this.renderGameSelect(container, this.roomState);
      return;
    }
    if (this.currentScreen === "stage") {
      this.renderStageShell(container);
      return;
    }
    if (this.currentScreen === "results") {
      this.renderResults(container, this.roomState);
    }
  }

  private renderDifficultyBarHtml(active: DifficultyPreset): string {
    const activeMeta = DIFFICULTY_PRESETS.find((d) => d.id === active) ?? DIFFICULTY_PRESETS[1]!;
    const buttons = DIFFICULTY_PRESETS.map(
      (d) => `
        <button
          type="button"
          class="diff-btn"
          data-set-difficulty="${d.id}"
          aria-pressed="${d.id === active}"
        >${escapeHtml(d.label)}</button>
      `,
    ).join("");

    return `
      <div class="difficulty-bar" data-difficulty-bar>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <strong>Target Speed / Difficulty</strong>
          <span class="diff-hint" data-diff-hint>${escapeHtml(activeMeta.shortDesc)}</span>
        </div>
        <div class="difficulty-group" role="group" aria-label="Difficulty preset">
          ${buttons}
        </div>
      </div>
    `;
  }

  private bindDifficultyButtons(container: HTMLElement): void {
    container.querySelectorAll<HTMLButtonElement>("[data-set-difficulty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const diff = btn.dataset.setDifficulty as DifficultyPreset;
        if (diff !== "casual" && diff !== "arcade" && diff !== "pro") return;
        this.hostClient.sendControl({ type: "host:set_difficulty", difficulty: diff });
        if (this.roomState) {
          this.roomState = { ...this.roomState, difficulty: diff };
        }
        container.querySelectorAll<HTMLButtonElement>("[data-set-difficulty]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b.dataset.setDifficulty === diff));
        });
        const meta = DIFFICULTY_PRESETS.find((d) => d.id === diff);
        const hintEl = container.querySelector("[data-diff-hint]");
        if (hintEl && meta) hintEl.textContent = meta.shortDesc;
      });
    });
  }

  private renderLobby(container: HTMLElement, state: PartyRoomStateSnapshot): void {
    const joinUrl = this.getJoinUrl();
    const playerCardsHtml = Array.from({ length: MAX_PLAYERS }, (_, slot) => {
      const p = state.players.find((row) => row.slot === slot);
      const palette = PLAYER_SLOT_PALETTE[slot]!;

      if (!p) {
        return `
          <article class="seat-card" data-occupied="false">
            <div class="seat-top">
              <span class="seat-name">Seat ${slot + 1} · Open</span>
              <span class="badge">${escapeHtml(palette.label)}</span>
            </div>
            <p class="seat-sub">Scan QR code or enter <strong>${escapeHtml(state.roomCode)}</strong> on phone /pad</p>
          </article>
        `;
      }

      const graceRemSec =
        !p.connected && p.disconnectedAt
          ? Math.max(0, Math.ceil((RECONNECT_GRACE_MS - (Date.now() - p.disconnectedAt)) / 1000))
          : 0;

      return `
        <article class="seat-card" data-occupied="true" style="--seat-color: ${escapeHtml(p.colorHex)};">
          <div class="seat-top">
            <div class="seat-ident">
              ${avatarSvg(p.avatarId, p.colorHex, 34)}
              <div>
                <div class="seat-name">${escapeHtml(p.name)}</div>
                <div class="seat-sub">Seat ${slot + 1} · Sens ${p.sensitivity.toFixed(2)}× · Dead ${p.deadZoneDeg.toFixed(1)}°</div>
              </div>
            </div>
            <button type="button" class="btn btn-ghost" data-kick-slot="${slot}" aria-label="Remove ${escapeHtml(p.name)}">Remove</button>
          </div>
          <div class="seat-badges">
            ${
              p.connected
                ? '<span class="badge badge-good">Connected</span>'
                : `<span class="badge badge-warn">Dropped · ${graceRemSec}s slot lock</span>`
            }
            <span class="badge ${p.calibrated ? "badge-good" : ""}">${escapeHtml(
              calibrationStepLabel(p.calibrationStep, p.calibrated),
            )}</span>
            ${p.ready ? '<span class="badge badge-good">Ready</span>' : ""}
          </div>
        </article>
      `;
    }).join("");

    const playerCount = state.players.length;
    container.innerHTML = `
      <div class="lobby-grid">
        <section class="panel pair-panel" aria-labelledby="pair-heading">
          <div>
            <h1 id="pair-heading">Join on your phone</h1>
            <p class="field-hint">Phones act as motion controllers. Open /pad on iOS Safari or Android Chrome.</p>
          </div>

          <div class="pair-code-block">
            <span class="pair-code-label">Room Code</span>
            <span class="pair-code-value">${escapeHtml(state.roomCode)}</span>
          </div>

          <div class="qr-card">
            <img data-qr-img alt="QR code to join room ${escapeHtml(state.roomCode)}" src="${escapeHtml(this.qrDataUrl)}" />
          </div>

          <div class="pair-url-row">
            <span class="mono" data-join-url-text>${escapeHtml(joinUrl)}</span>
            <button type="button" class="btn btn-ghost" data-copy-url>${
              this.copiedFlash ? "Copied" : "Copy link"
            }</button>
          </div>
        </section>

        <section class="seats-column" aria-labelledby="seats-heading">
          <div class="seats-header">
            <div>
              <h2 id="seats-heading">Controllers (${playerCount}/${MAX_PLAYERS})</h2>
              <p class="field-hint">Or click Simulator in the header to test with your mouse.</p>
            </div>
          </div>

          <div class="seats-grid">${playerCardsHtml}</div>

          ${this.renderDifficultyBarHtml(state.difficulty)}

          <div class="lobby-cta-bar">
            <button type="button" class="btn btn-accent" data-play-targets ${
              playerCount === 0 ? "disabled" : ""
            }>Play Target Shooting</button>
            <button type="button" class="btn btn-accent" data-play-fruits ${
              playerCount === 0 ? "disabled" : ""
            }>Play Fruit Slicer</button>
            <button type="button" class="btn btn-accent" data-play-archery ${
              playerCount === 0 ? "disabled" : ""
            }>Play Archery</button>
            <button type="button" class="btn btn-primary" data-launch-calib ${
              playerCount === 0 ? "disabled" : ""
            }>Calibrate</button>
            <button type="button" class="btn btn-ghost" data-quick-aim ${
              playerCount === 0 ? "disabled" : ""
            }>Aim Lab</button>
            <button type="button" class="btn btn-ghost" data-open-catalog>Game Roster</button>
          </div>
        </section>
      </div>
    `;

    this.bindDifficultyButtons(container);

    container.querySelector("[data-copy-url]")?.addEventListener("click", () => {
      void navigator.clipboard?.writeText(joinUrl).then(() => {
        this.copiedFlash = true;
        this.renderMainScreen(true);
        window.setTimeout(() => {
          this.copiedFlash = false;
          if (this.currentScreen === "lobby") this.renderMainScreen(true);
        }, 1600);
      });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-kick-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slot = Number(btn.dataset.kickSlot);
        if (Number.isInteger(slot)) {
          this.hostClient.sendControl({ type: "host:kick", slot });
        }
      });
    });

    container.querySelector("[data-play-targets]")?.addEventListener("click", () => {
      this.audio.unlock();
      this.hostClient.sendControl({ type: "host:select_game", gameId: "target-shooting" });
      this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
    });

    container.querySelector("[data-play-fruits]")?.addEventListener("click", () => {
      this.audio.unlock();
      this.hostClient.sendControl({ type: "host:select_game", gameId: "fruit-slicer" });
      this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
    });

    container.querySelector("[data-play-archery]")?.addEventListener("click", () => {
      this.audio.unlock();
      this.hostClient.sendControl({ type: "host:select_game", gameId: "archery" });
      this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
    });

    container.querySelector("[data-launch-calib]")?.addEventListener("click", () => {
      this.audio.unlock();
      this.hostClient.sendControl({ type: "host:select_game", gameId: "aim-demo" });
      this.hostClient.sendControl({ type: "host:set_phase", phase: "calibration" });
    });

    container.querySelector("[data-quick-aim]")?.addEventListener("click", () => {
      this.audio.unlock();
      this.hostClient.sendControl({ type: "host:select_game", gameId: "aim-demo" });
      this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
    });

    container.querySelector("[data-open-catalog]")?.addEventListener("click", () => {
      this.audio.unlock();
      this.hostClient.sendControl({ type: "host:set_phase", phase: "game_select" });
    });
  }

  private renderGameSelect(container: HTMLElement, state: PartyRoomStateSnapshot): void {
    const cardsHtml = GAME_CATALOG.map((g, idx) => {
      const unlocked = isGameImplemented(g.id);
      const controlsHtml = g.controlsSummary
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("");

      return `
        <article class="game-card" data-active="${state.selectedGame === g.id}" data-locked="${!unlocked}">
          <div>
            <div class="seat-top">
              <h2>${escapeHtml(g.title)}</h2>
              <span class="badge ${unlocked ? "badge-good" : ""}">${
                unlocked ? "Ready" : `Milestone ${idx + 1}`
              }</span>
            </div>
            <p class="field-hint" style="margin-top: 0.4rem;">${escapeHtml(g.tagline)}</p>
          </div>
          <ul class="controls-list">${controlsHtml}</ul>
          <div class="host-actions">
            ${
              unlocked
                ? `
                  <button type="button" class="btn btn-accent" data-pick-calib="${g.id}">Calibrate & Start</button>
                  <button type="button" class="btn btn-primary" data-pick-start="${g.id}">Instant Launch</button>
                `
                : `<button type="button" class="btn btn-ghost" disabled>Ships next milestone</button>`
            }
          </div>
        </article>
      `;
    }).join("");

    container.innerHTML = `
      <div class="seats-header">
        <div>
          <h1>Select Activity</h1>
          <p class="field-hint">Aim Lab, Target Shooting, Fruit Slicer &amp; Archery are playable now; Cricket unlocks next.</p>
        </div>
        <button type="button" class="btn btn-ghost" data-back-lobby>Back to Lobby</button>
      </div>
      ${this.renderDifficultyBarHtml(state.difficulty)}
      <div class="catalog-grid">${cardsHtml}</div>
    `;

    this.bindDifficultyButtons(container);

    container.querySelector("[data-back-lobby]")?.addEventListener("click", () => {
      this.hostClient.sendControl({ type: "host:set_phase", phase: "lobby" });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-pick-calib]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const gameId = btn.dataset.pickCalib as GameId;
        this.hostClient.sendControl({ type: "host:select_game", gameId });
        this.hostClient.sendControl({ type: "host:set_phase", phase: "calibration" });
      });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-pick-start]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const gameId = btn.dataset.pickStart as GameId;
        this.hostClient.sendControl({ type: "host:select_game", gameId });
        this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
      });
    });
  }

  private renderStageShell(container: HTMLElement): void {
    container.innerHTML = `
      <div class="stage-shell">
        <div data-stage-mount style="inline-size: 100%; block-size: 100%; min-block-size: min(74dvh, 760px);"></div>

        <div class="stage-hud-top" data-no-sim>
          <div class="stage-hud-card">
            <div class="hud-title" data-hud-title>Aim Dot Calibration Lab</div>
            <ul class="hud-lines" data-hud-tutorial></ul>
            <div class="hud-announce" data-hud-announce aria-live="polite"></div>
          </div>

          <div class="stage-hud-card" style="display: flex; flex-direction: column; gap: 0.5rem;">
            <div style="display: flex; align-items: center; justify-content: flex-end; gap: 0.65rem; flex-wrap: wrap;">
              <span class="hud-wind-pill mono" data-hud-wind hidden>Wind → 0.0</span>
              <span class="hud-diff-pill" data-hud-difficulty hidden>Arcade</span>
              <span class="round-timer mono" data-hud-timer hidden>60.0s</span>
              <div class="scoreboard-strip" data-hud-scoreboard></div>
            </div>
            <div class="host-actions" data-stage-actions></div>
          </div>
        </div>

        <div class="countdown-banner" data-countdown-banner hidden></div>

        <div class="calib-hud-bottom" data-no-sim data-calib-strip hidden>
          <div class="calib-mirror-list" data-calib-players></div>
          <div class="stage-hud-card">
            <strong>Live Center Calibration</strong>
            <p class="field-hint">Follow the 3 steps on your phone. Reticles move live here as you aim at the center ring.</p>
          </div>
        </div>
      </div>
    `;

    this.stageMountEl = container.querySelector("[data-stage-mount]");
    if (this.stageMountEl) {
      this.stageResizeObserver = new ResizeObserver(() => {
        if (!this.stageMountEl || !this.activePlugin?.onResize) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.engine.getRenderScale();
        this.activePlugin.onResize(
          this.stageMountEl.clientWidth,
          this.stageMountEl.clientHeight,
          dpr,
        );
      });
      this.stageResizeObserver.observe(this.stageMountEl);
    }

    this.patchStageOverlay();
  }

  private patchStageOverlay(): void {
    if (!this.roomState) return;
    const gameEntry = GAME_CATALOG.find((g) => g.id === this.roomState?.selectedGame);
    const titleEl = this.root.querySelector("[data-hud-title]");
    if (titleEl) {
      titleEl.textContent =
        this.roomState.phase === "calibration"
          ? "Sensor Calibration + Live Mirror"
          : (gameEntry?.title ?? "Aim Lab");
    }

    const diffEl = this.root.querySelector<HTMLElement>("[data-hud-difficulty]");
    if (diffEl) {
      const showDiff =
        this.roomState.phase !== "calibration" &&
        (this.roomState.selectedGame === "target-shooting" ||
          this.roomState.selectedGame === "fruit-slicer" ||
          this.roomState.selectedGame === "archery");
      diffEl.hidden = !showDiff;
      diffEl.textContent =
        this.roomState.difficulty === "casual"
          ? "Chill"
          : this.roomState.difficulty === "pro"
            ? "Turbo 1.25×"
            : "Arcade";
    }

    const actionsEl = this.root.querySelector("[data-stage-actions]");
    if (actionsEl) {
      if (this.roomState.phase === "calibration") {
        actionsEl.innerHTML = `
          <button type="button" class="btn btn-accent" data-stage-start>Start ${escapeHtml(
            gameEntry?.title ?? "Round",
          )}</button>
          <button type="button" class="btn btn-ghost" data-stage-lobby>Lobby</button>
        `;
        actionsEl.querySelector("[data-stage-start]")?.addEventListener("click", () => {
          this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
        });
      } else {
        actionsEl.innerHTML = `
          <button type="button" class="btn btn-ghost" data-stage-recalib>Recalibrate</button>
          <button type="button" class="btn btn-primary" data-stage-finish>End & Scores</button>
          <button type="button" class="btn btn-ghost" data-stage-lobby>Lobby</button>
        `;
        actionsEl.querySelector("[data-stage-recalib]")?.addEventListener("click", () => {
          this.hostClient.sendControl({ type: "host:set_phase", phase: "calibration" });
        });
        actionsEl.querySelector("[data-stage-finish]")?.addEventListener("click", () => {
          const scores = this.activePlugin?.getScores() ?? [];
          this.audio.play("end");
          this.hostClient.sendControl({ type: "host:round_result", scores });
        });
      }

      actionsEl.querySelector("[data-stage-lobby]")?.addEventListener("click", () => {
        this.hostClient.sendControl({ type: "host:set_phase", phase: "lobby" });
      });
    }

    const calibStrip = this.root.querySelector<HTMLElement>("[data-calib-strip]");
    const calibList = this.root.querySelector("[data-calib-players]");
    if (calibStrip && calibList) {
      const showCalib = this.roomState.phase === "calibration";
      calibStrip.hidden = !showCalib;
      if (showCalib) {
        calibList.innerHTML = this.roomState.players
          .map(
            (p) => `
              <div class="calib-player-chip" style="border-inline-start: 4px solid ${escapeHtml(p.colorHex)};">
                <strong>${escapeHtml(p.name)}</strong>
                <span class="field-hint">${escapeHtml(
                  calibrationStepLabel(p.calibrationStep, p.calibrated),
                )}</span>
              </div>
            `,
          )
          .join("");
      }
    }
  }

  private updateCountdownLoop(): void {
    this.stopCountdownLoop();
    const banner = this.root.querySelector<HTMLElement>("[data-countdown-banner]");
    if (!banner || !this.roomState || this.roomState.phase !== "countdown") {
      if (banner) banner.hidden = true;
      return;
    }

    let lastSec = -1;
    const renderTick = () => {
      if (!this.roomState || this.roomState.phase !== "countdown") {
        banner.hidden = true;
        this.stopCountdownLoop();
        return;
      }
      const elapsed = Date.now() - this.roomState.phaseStartedAt;
      const rem = Math.max(1, Math.ceil((3000 - elapsed) / 1000));
      banner.hidden = false;
      banner.textContent = String(rem);
      if (rem !== lastSec) {
        lastSec = rem;
        this.audio.play("tick");
      }
    };
    renderTick();
    this.countdownTickTimer = window.setInterval(renderTick, 100);
  }

  private stopCountdownLoop(): void {
    if (this.countdownTickTimer !== null) {
      window.clearInterval(this.countdownTickTimer);
      this.countdownTickTimer = null;
    }
  }

  private async ensurePluginMounted(): Promise<void> {
    if (!this.roomState || !this.stageMountEl) return;
    const targetGame: GameId =
      this.roomState.phase === "calibration" ? "aim-demo" : this.roomState.selectedGame;
    if (this.activePlugin && this.activeGameLoadedId === targetGame) {
      return;
    }

    const plugin = await loadGamePlugin(targetGame);
    if (this.currentScreen !== "stage" || !this.stageMountEl) {
      plugin.dispose();
      return;
    }

    const getPlayers = () => this.roomState?.players ?? [];
    const getPhase = () => this.roomState?.phase ?? "lobby";
    let lastTimerShown = "";

    const ctx: GameHostContext = {
      container: this.stageMountEl,
      get players() {
        return getPlayers();
      },
      seed: Date.now() & 0xffffff,
      difficulty: this.roomState.difficulty,
      getPhase,
      hud: {
        setRoundTimer: (remainingMs) => {
          const timerEl = this.root.querySelector<HTMLElement>("[data-hud-timer]");
          if (!timerEl) return;
          if (remainingMs === null) {
            timerEl.hidden = true;
            return;
          }
          timerEl.hidden = false;
          const secs = Math.max(0, remainingMs / 1000);
          const formatted = secs < 10 ? `${secs.toFixed(1)}s` : `${Math.ceil(secs)}s`;
          if (formatted !== lastTimerShown) {
            lastTimerShown = formatted;
            timerEl.textContent = formatted;
            timerEl.setAttribute("data-urgent", String(secs <= 10));
          }
        },
        setRoundLabel: (label, urgent = false) => {
          const timerEl = this.root.querySelector<HTMLElement>("[data-hud-timer]");
          if (!timerEl) return;
          if (!label) {
            timerEl.hidden = true;
            return;
          }
          timerEl.hidden = false;
          if (label !== lastTimerShown) {
            lastTimerShown = label;
            timerEl.textContent = label;
            timerEl.setAttribute("data-urgent", String(urgent));
          }
        },
        setTutorialVisible: (visible, lines) => {
          const list = this.root.querySelector<HTMLElement>("[data-hud-tutorial]");
          if (!list) return;
          list.hidden = !visible;
          list.innerHTML = (lines ?? []).map((l) => `<li>${escapeHtml(l)}</li>`).join("");
        },
        announce: (text) => {
          this.announceText = text;
          const el = this.root.querySelector("[data-hud-announce]");
          if (el) el.textContent = text;
          if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
          this.announceTimer = window.setTimeout(() => {
            this.announceText = "";
            const target = this.root.querySelector("[data-hud-announce]");
            if (target) target.textContent = "";
          }, 1800);
        },
        setWindHud: (label) => {
          const windEl = this.root.querySelector<HTMLElement>("[data-hud-wind]");
          if (!windEl) return;
          if (!label) {
            windEl.hidden = true;
            return;
          }
          windEl.hidden = false;
          windEl.textContent = label;
        },
        updateScoreboard: (players) => {
          this.latestScoreboard = [...players];
          this.renderScoreboardStrip();
        },
        setPlayerAmmoHud: (players) => {
          for (const row of players) {
            this.playerAmmoState.set(row.slot, {
              ammo: row.ammo,
              maxAmmo: row.maxAmmo,
              reloading: row.reloading,
              streak: row.streak,
            });
          }
          this.renderScoreboardStrip();
        },
      },
      audio: this.audio,
      fx: {
        addScreenShake: (intensity) => this.engine.addScreenShake(intensity),
        triggerHitStop: (durationMs) => this.engine.triggerHitStop(durationMs),
      },
      sendHaptic: (slot, pattern: HapticPattern) => {
        this.hostClient.sendControl({ type: "host:haptic", slot, pattern });
      },
      sendPadHud: (slot, payload) => {
        this.hostClient.sendControl({ type: "host:pad_hud", slot, ...payload });
      },
      finishRound: (scores) => {
        this.hostClient.sendControl({ type: "host:round_result", scores });
      },
    };

    try {
      await plugin.init(ctx);
      this.activePlugin = plugin;
      this.activeGameLoadedId = targetGame;
      this.engine.setPlugin(plugin);
      this.engine.start();
    } catch (err) {
      this.errorBanner =
        err instanceof Error ? `WebGL stage init failed: ${err.message}` : "Stage init failed.";
      this.renderErrorBanner();
    }
  }

  private renderScoreboardStrip(): void {
    const sb = this.root.querySelector("[data-hud-scoreboard]");
    if (!sb) return;
    sb.innerHTML = this.latestScoreboard
      .map((p) => {
        const ammoInfo = this.playerAmmoState.get(p.slot);
        let ammoHtml = "";
        if (ammoInfo) {
          const isLow = ammoInfo.ammo > 0 && ammoInfo.ammo <= 2 && !ammoInfo.reloading;
          const dots = Array.from({ length: ammoInfo.maxAmmo }, (_, idx) => {
            const filled = ammoInfo.reloading || idx < ammoInfo.ammo;
            return `<span class="ammo-dot" data-filled="${filled}" data-low="${isLow && filled}"></span>`;
          }).join("");
          const streakHtml =
            ammoInfo.streak >= 2 ? `<span class="streak-tag">×${ammoInfo.streak}</span>` : "";
          ammoHtml = `<span class="score-ammo-strip" role="img" aria-label="Ammo ${ammoInfo.ammo} of ${ammoInfo.maxAmmo}">${dots}</span>${streakHtml}`;
        }

        let livesHtml = "";
        const hasLives = typeof p.lives === "number" && typeof p.maxLives === "number";
        const isOut = hasLives && (p.lives ?? 0) <= 0;
        if (hasLives) {
          const maxL = p.maxLives ?? 3;
          const curL = p.lives ?? 0;
          const hearts = Array.from({ length: maxL }, (_, idx) => {
            const alive = idx < curL;
            return `<svg class="life-pip" data-alive="${alive}" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.2 1.9 8.4a3.9 3.9 0 0 1 5.5-5.5L8 3.6l.6-.7a3.9 3.9 0 0 1 5.5 5.5L8 14.2Z"/></svg>`;
          }).join("");
          const outTag = isOut ? `<span class="ko-tag">OUT</span>` : "";
          livesHtml = `<span class="score-lives-strip" role="img" aria-label="Lives ${curL} of ${maxL}">${hearts}</span>${outTag}`;
        }

        let attemptsHtml = "";
        if (p.attempts && p.attempts.length > 0) {
          const boxes = p.attempts
            .map((pts, idx) => {
              const state = pts === null ? "pending" : pts === 0 ? "miss" : pts >= 90 ? "gold" : "hit";
              const text = pts === null ? "·" : pts === 0 ? "M" : String(pts);
              return `<span class="attempt-box mono" data-state="${state}" title="End ${idx + 1}">${text}</span>`;
            })
            .join("");
          attemptsHtml = `<span class="score-attempts-strip" aria-label="Attempt scores">${boxes}</span>`;
        }

        return `
          <span class="score-pill" data-eliminated="${isOut}" style="--seat-color: ${escapeHtml(p.colorHex)};">
            <span class="score-swatch" style="background-color: ${escapeHtml(p.colorHex)};"></span>
            <span>${escapeHtml(p.name)}</span>
            <strong class="mono">${p.score}</strong>
            ${livesHtml}
            ${ammoHtml}
            ${attemptsHtml}
          </span>
        `;
      })
      .join("");
  }

  private teardownStage(): void {
    this.audio.stopMusic();
    this.playerAmmoState.clear();
    this.latestScoreboard = [];
    this.engine.setPlugin(null);
    this.stageResizeObserver?.disconnect();
    this.stageResizeObserver = null;
    if (this.activePlugin) {
      this.activePlugin.dispose();
      this.activePlugin = null;
      this.activeGameLoadedId = null;
    }
    this.stageMountEl = null;
  }

  private renderResults(container: HTMLElement, state: PartyRoomStateSnapshot): void {
    const gameEntry = GAME_CATALOG.find((g) => g.id === state.selectedGame);
    const title = gameEntry?.title ?? "Round";
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    const rowsHtml = sorted
      .map(
        (p, rank) => `
          <div class="result-row" style="border-inline-start: 4px solid ${escapeHtml(p.colorHex)};">
            <div class="seat-ident">
              <span class="mono">#${rank + 1}</span>
              ${avatarSvg(p.avatarId, p.colorHex, 30)}
              <div>
                <div class="seat-name">${escapeHtml(p.name)} ${
                  rank === 0 && p.score > 0 ? '<span class="badge badge-good">Winner</span>' : ""
                }</div>
                <div class="seat-sub">Room wins: ${p.wins}</div>
              </div>
            </div>
            <strong class="mono" style="font-size: 1.35rem;">${p.score.toLocaleString()} pts</strong>
          </div>
        `,
      )
      .join("");

    container.innerHTML = `
      <section class="panel" style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="seats-header">
          <div>
            <h1>${escapeHtml(title)} Results</h1>
            <p class="field-hint">Local room standings for room ${escapeHtml(state.roomCode)}.</p>
          </div>
          <div class="host-actions">
            <button type="button" class="btn btn-accent" data-rematch>Rematch</button>
            <button type="button" class="btn btn-primary" data-results-catalog>Change Game</button>
            <button type="button" class="btn btn-ghost" data-recalib>Recalibrate</button>
            <button type="button" class="btn btn-ghost" data-results-lobby>Lobby</button>
          </div>
        </div>
        <div class="results-list">${rowsHtml || '<p class="field-hint">No active players scored.</p>'}</div>
        <div style="display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.5rem;">
          <div class="host-actions">
            <button type="button" class="btn btn-ghost" data-download-card>Download Result Card (PNG)</button>
            <button type="button" class="btn btn-ghost" data-share-card hidden>Share Result</button>
          </div>
          <img class="result-card-preview" data-result-card-img alt="Shareable match result card" hidden />
        </div>
      </section>
    `;

    container.querySelector("[data-rematch]")?.addEventListener("click", () => {
      this.hostClient.sendControl({ type: "host:start_round", seed: Date.now() & 0xffffff });
    });
    container.querySelector("[data-results-catalog]")?.addEventListener("click", () => {
      this.hostClient.sendControl({ type: "host:set_phase", phase: "game_select" });
    });
    container.querySelector("[data-recalib]")?.addEventListener("click", () => {
      this.hostClient.sendControl({ type: "host:set_phase", phase: "calibration" });
    });
    container.querySelector("[data-results-lobby]")?.addEventListener("click", () => {
      this.hostClient.sendControl({ type: "host:set_phase", phase: "lobby" });
    });

    void renderShareableResultCard(title, state.roomCode, sorted).then(({ dataUrl, blob }) => {
      if (!dataUrl) return;
      const preview = container.querySelector<HTMLImageElement>("[data-result-card-img]");
      if (preview) {
        preview.src = dataUrl;
        preview.hidden = false;
      }
      container.querySelector("[data-download-card]")?.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `gyro-${state.selectedGame}-${state.roomCode.toLowerCase()}.png`;
        a.click();
      });

      const shareBtn = container.querySelector<HTMLButtonElement>("[data-share-card]");
      if (shareBtn && blob && typeof navigator.canShare === "function") {
        const file = new File([blob], `gyro-${state.selectedGame}.png`, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          shareBtn.hidden = false;
          shareBtn.addEventListener("click", () => {
            void navigator.share({
              title: `${title} — Gyro-Gamezone`,
              text: `Room ${state.roomCode} standings`,
              files: [file],
            }).catch(() => {});
          });
        }
      }
    });
  }

  private renderDebugDrawer(): void {
    const btn = this.root.querySelector<HTMLButtonElement>("[data-toggle-debug]");
    if (btn) btn.setAttribute("aria-pressed", String(this.showDebug));
    const slot = this.root.querySelector("[data-debug-slot]");
    if (!slot) return;
    if (!this.showDebug) {
      slot.innerHTML = "";
      return;
    }
    this.patchDebugDrawer();
  }

  private patchDebugDrawer(): void {
    const slot = this.root.querySelector("[data-debug-slot]");
    if (!slot || !this.showDebug) return;

    const now = performance.now();
    const mask = (this.roomState?.players ?? []).reduce(
      (acc, p) => (p.connected ? acc | (1 << p.slot) : acc),
      0,
    );
    const sampled = this.hostClient.inputBuffer.sampleAll(now, mask);
    const slotLines = (this.roomState?.players ?? [])
      .map((p) => {
        const hz = this.hostClient.inputBuffer.getSlotInputHz(p.slot);
        const f = sampled[p.slot];
        return `<div>P${p.slot + 1} ${hz}Hz (${f ? f.cursorX.toFixed(2) : "0"}, ${f ? f.cursorY.toFixed(2) : "0"}) ${f?.simulator ? "[SIM]" : ""}</div>`;
      })
      .join("");

    slot.innerHTML = `
      <aside class="debug-drawer" data-no-sim aria-label="Host telemetry debug overlay">
        <strong>Telemetry [D to hide]</strong>
        <div>FPS: ${this.telemetry.fps} · Frame: ${this.telemetry.frameMs} ms</div>
        <div>Scale: ${this.telemetry.renderScale.toFixed(2)}× · DPR: ${this.telemetry.effectiveDpr}</div>
        <div>Host RTT: ${this.rttMs} ms · Announce: ${escapeHtml(this.announceText || "-")}</div>
        <div>Last gesture: ${escapeHtml(this.lastGestureText)}</div>
        ${slotLines || "<div>No controllers connected</div>"}
      </aside>
    `;
  }
}

const root = document.getElementById("app");
if (root) {
  new HostApp(root);
}
