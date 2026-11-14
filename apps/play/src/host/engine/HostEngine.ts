import type { GamePlugin, PartyRoomStateSnapshot, PlayerGestureEvent } from "@gyro/shared";
import type { HostInputBuffer } from "../net/InputBuffer.js";

export interface EngineTelemetry {
  fps: number;
  frameMs: number;
  renderScale: number;
  effectiveDpr: number;
}

const FIXED_DT = 1 / 60;
const MAX_FRAME_ACCUM = FIXED_DT * 4;

export class HostEngine {
  private plugin: GamePlugin | null = null;
  private rafId: number | null = null;
  private lastRafTs = 0;
  private accumulator = 0;

  private shakeIntensity = 0;
  private hitStopRemainingMs = 0;

  private renderScale = 1.0;
  private avgFrameMs = 16.6;
  private fpsSamples = 0;
  private fpsWindowStart = 0;
  private currentFps = 60;

  constructor(
    private readonly inputBuffer: HostInputBuffer,
    private readonly getState: () => PartyRoomStateSnapshot | null,
    private readonly onResizeScale: (scale: number, dpr: number) => void,
    private readonly onTelemetry?: (t: EngineTelemetry) => void,
  ) {}

  setPlugin(plugin: GamePlugin | null): void {
    this.plugin = plugin;
    this.accumulator = 0;
    this.shakeIntensity = 0;
    this.hitStopRemainingMs = 0;
  }

  addScreenShake(intensity: number): void {
    this.shakeIntensity = Math.min(1.5, this.shakeIntensity + intensity);
  }

  triggerHitStop(durationMs: number): void {
    this.hitStopRemainingMs = Math.max(this.hitStopRemainingMs, durationMs);
  }

  getShakeIntensity(): number {
    return this.shakeIntensity;
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  forwardGesture(ev: PlayerGestureEvent): void {
    this.plugin?.onGesture?.(ev);
  }

  start(): void {
    if (this.rafId !== null) return;
    this.lastRafTs = performance.now();
    this.fpsWindowStart = this.lastRafTs;

    const loop = (now: number) => {
      this.rafId = window.requestAnimationFrame(loop);
      const rawDtMs = Math.max(0, now - this.lastRafTs);
      this.lastRafTs = now;

      // Adaptive resolution scaling: protects 30fps floor and targets 60fps
      this.avgFrameMs = this.avgFrameMs * 0.92 + Math.min(rawDtMs, 50) * 0.08;
      this.fpsSamples += 1;
      if (now - this.fpsWindowStart >= 1000) {
        this.currentFps = Math.round((this.fpsSamples * 1000) / (now - this.fpsWindowStart));
        this.fpsSamples = 0;
        this.fpsWindowStart = now;

        let nextScale = this.renderScale;
        if (this.avgFrameMs > 24 && this.renderScale > 0.7) {
          nextScale = Math.max(0.7, Number((this.renderScale - 0.1).toFixed(2)));
        } else if (this.avgFrameMs < 17.5 && this.renderScale < 1.0) {
          nextScale = Math.min(1.0, Number((this.renderScale + 0.05).toFixed(2)));
        }
        const effectiveDpr = Math.min(window.devicePixelRatio || 1, 2) * nextScale;
        if (nextScale !== this.renderScale) {
          this.renderScale = nextScale;
          this.onResizeScale(this.renderScale, effectiveDpr);
        }
        this.onTelemetry?.({
          fps: this.currentFps,
          frameMs: Number(this.avgFrameMs.toFixed(1)),
          renderScale: this.renderScale,
          effectiveDpr: Number(effectiveDpr.toFixed(2)),
        });
      }

      if (!this.plugin) return;

      if (this.hitStopRemainingMs > 0) {
        this.hitStopRemainingMs = Math.max(0, this.hitStopRemainingMs - rawDtMs);
        this.plugin.render(0);
        return;
      }

      const dtSec = Math.min(rawDtMs / 1000, MAX_FRAME_ACCUM);
      this.accumulator += dtSec;

      const state = this.getState();
      let connectedMask = 0;
      if (state) {
        for (const p of state.players) {
          if (p.connected) connectedMask |= 1 << p.slot;
        }
      }

      while (this.accumulator >= FIXED_DT) {
        const inputs = this.inputBuffer.sampleAll(now, connectedMask);
        this.plugin.update(FIXED_DT, inputs);
        this.shakeIntensity = Math.max(0, this.shakeIntensity - FIXED_DT * 3.5);
        this.accumulator -= FIXED_DT;
      }

      const alpha = this.accumulator / FIXED_DT;
      this.plugin.render(alpha);
    };

    this.rafId = window.requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
