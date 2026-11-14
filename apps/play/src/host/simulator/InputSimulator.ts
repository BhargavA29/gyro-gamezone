import type { Room } from "@colyseus/sdk";
import {
  clamp,
  INPUT_FLAG_CALIBRATED,
  INPUT_FLAG_PRIMARY,
  INPUT_FLAG_SIMULATOR,
  INPUT_PACKET_BYTES,
  INPUT_SEND_INTERVAL_MS,
  MSG_CONTROL,
  MSG_INPUT_BINARY,
  packInputPacket,
  type GestureKind,
  type PadToServerMessage,
  type ServerToClientMessage,
} from "@gyro/shared";
import { createColyseusClient } from "../../common/colyseus-client.js";

/**
 * Local desktop input simulator ("mouse-as-gyro"):
 * Joins the live Colyseus room as a real virtual pad so testing exercises the full
 * binary 60 Hz WebSocket pipeline without needing a physical phone nearby.
 */
export class InputSimulator {
  private readonly client = createColyseusClient();
  private room: Room | null = null;
  private slot = -1;
  private active = false;
  private seq = 0;
  private gestureSeq = 0;

  private aimYaw = 0;
  private aimPitch = 0;
  private roll = 0;
  private primaryDown = false;
  private downTs = 0;
  private holding = false;
  private holdTimer: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private prevYaw = 0;
  private prevPitch = 0;

  private rafId: number | null = null;
  private lastSendTs = 0;
  private readonly packetBuf = new ArrayBuffer(INPUT_PACKET_BYTES);
  private readonly packetView = new DataView(this.packetBuf);
  private readonly packetBytes = new Uint8Array(this.packetBuf);

  constructor(private readonly onStatusChange?: (active: boolean, slot: number) => void) {}

  isActive(): boolean {
    return this.active;
  }

  async start(roomCode: string, name = "Sim-Mouse"): Promise<void> {
    if (this.active) return;
    const room = await this.client.joinById(roomCode, {
      role: "pad",
      name,
      avatarId: "prism",
    });
    this.room = room;
    this.active = true;

    room.onMessage(MSG_CONTROL, (msg: ServerToClientMessage) => {
      if (msg.type === "srv:welcome" && typeof msg.slot === "number") {
        this.slot = msg.slot;
        this.sendControl({ type: "pad:calibration", step: "done", ok: true, noiseFloor: 0.001 });
        this.sendControl({ type: "pad:ready", ready: true });
        this.onStatusChange?.(true, this.slot);
      }
    });

    this.attachWindowListeners();
    this.startLoop();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.detachWindowListeners();
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.room) {
      await this.room.leave(true);
      this.room = null;
    }
    this.slot = -1;
    this.onStatusChange?.(false, -1);
  }

  private sendControl(msg: PadToServerMessage): void {
    this.room?.send(MSG_CONTROL, msg);
  }

  private emitGesture(kind: GestureKind, dx = 0, dy = 0, power = 1): void {
    this.gestureSeq += 1;
    this.sendControl({
      type: "pad:gesture",
      seq: this.gestureSeq,
      kind,
      dx,
      dy,
      power,
      clientTs: performance.now(),
    });
  }

  private onMouseMove = (e: MouseEvent) => {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const nx = (e.clientX / w) * 2 - 1;
    const ny = 1 - (e.clientY / h) * 2;
    this.aimYaw = clamp(nx * 0.58, -1.1, 1.1);
    this.aimPitch = clamp(ny * 0.38, -0.8, 0.8);
    this.roll = clamp((e.clientX - this.lastX) * 0.015, -0.7, 0.7);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, dialog, [data-no-sim]")) return;

    this.primaryDown = true;
    this.downTs = performance.now();
    this.holding = false;
    this.holdTimer = window.setTimeout(() => {
      if (this.primaryDown) {
        this.holding = true;
        this.emitGesture("hold_start", 0, 0, 1);
      }
    }, 200);
  };

  private onMouseUp = (e: MouseEvent) => {
    if (!this.primaryDown) return;
    this.primaryDown = false;
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.holding) {
      this.holding = false;
      this.emitGesture("hold_end", 0, 0, clamp((performance.now() - this.downTs) / 1000, 0.2, 2));
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, dialog, [data-no-sim]")) return;
    this.emitGesture("tap", 0, 0, 1);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "r" || e.key === "R") {
      this.emitGesture("flick", 0, -1, 1.2);
    } else if (e.code === "Space") {
      e.preventDefault();
      this.emitGesture("swing", 1, -0.3, 1.3);
    } else if (e.key === "c" || e.key === "C") {
      this.aimYaw = 0;
      this.aimPitch = 0;
      this.roll = 0;
      this.sendControl({ type: "pad:recenter" });
    }
  };

  private attachWindowListeners(): void {
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
  }

  private detachWindowListeners(): void {
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
  }

  private startLoop(): void {
    const tick = (now: number) => {
      if (!this.active) return;
      this.rafId = window.requestAnimationFrame(tick);

      if (now - this.lastSendTs >= INPUT_SEND_INTERVAL_MS && this.room && this.slot >= 0) {
        const dt = Math.max(0.008, (now - this.lastSendTs) / 1000);
        this.lastSendTs = now;
        const angVelMag = Math.hypot(this.aimYaw - this.prevYaw, this.aimPitch - this.prevPitch) / dt;
        this.prevYaw = this.aimYaw;
        this.prevPitch = this.aimPitch;

        let flags = INPUT_FLAG_CALIBRATED | INPUT_FLAG_SIMULATOR;
        if (this.primaryDown) flags |= INPUT_FLAG_PRIMARY;

        packInputPacket(this.packetView, {
          seq: (this.seq = (this.seq + 1) & 0xffff),
          slot: this.slot,
          flags,
          clientTs: now,
          aimYaw: this.aimYaw,
          aimPitch: this.aimPitch,
          roll: this.roll,
          angVelMag,
          gesturePower: 0,
        });
        this.room.sendBytes(MSG_INPUT_BINARY, this.packetBytes);
      }
    };
    this.rafId = window.requestAnimationFrame(tick);
  }
}
