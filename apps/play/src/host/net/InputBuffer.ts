import {
  clamp,
  createEmptyInputPacket,
  INPUT_FLAG_CALIBRATED,
  INPUT_FLAG_PRIMARY,
  INPUT_FLAG_SECONDARY,
  INPUT_FLAG_SIMULATOR,
  MAX_PLAYERS,
  unpackInputPacket,
  type InputPacket,
  type PlayerAimFrame,
} from "@gyro/shared";

interface BufferedSample {
  recvAtMs: number;
  pkt: InputPacket;
}

const RING_SIZE = 8;
const INTERP_DELAY_MS = 24;
const YAW_FULL_SCALE_RAD = 0.58; // ~33 deg left/right to screen edge
const PITCH_FULL_SCALE_RAD = 0.38; // ~22 deg up/down to screen edge

export class HostInputBuffer {
  private readonly rings: BufferedSample[][] = [];
  private readonly writeIdx = new Uint8Array(MAX_PLAYERS);
  private readonly counts = new Uint8Array(MAX_PLAYERS);
  private readonly hzCounters = new Uint16Array(MAX_PLAYERS);
  private readonly hzRates = new Uint16Array(MAX_PLAYERS);
  private hzWindowStart = performance.now();

  private readonly decodeScratch = createEmptyInputPacket();
  private readonly frames: PlayerAimFrame[] = [];

  constructor() {
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const ring: BufferedSample[] = [];
      for (let i = 0; i < RING_SIZE; i++) {
        ring.push({ recvAtMs: 0, pkt: createEmptyInputPacket(s) });
      }
      this.rings.push(ring);
      this.frames.push({
        slot: s as 0 | 1 | 2 | 3,
        connected: false,
        cursorX: 0,
        cursorY: 0,
        yawRad: 0,
        pitchRad: 0,
        rollRad: 0,
        angVelMag: 0,
        primaryDown: false,
        secondaryDown: false,
        calibrated: false,
        simulator: false,
      });
    }
  }

  pushBinaryPacket(bytes: Uint8Array, recvAtMs = performance.now()): void {
    if (!unpackInputPacket(bytes, this.decodeScratch)) return;
    const slot = this.decodeScratch.slot;
    if (slot < 0 || slot >= MAX_PLAYERS) return;

    const ring = this.rings[slot]!;
    const idx = this.writeIdx[slot]!;
    const entry = ring[idx]!;
    entry.recvAtMs = recvAtMs;
    entry.pkt.seq = this.decodeScratch.seq;
    entry.pkt.slot = slot;
    entry.pkt.flags = this.decodeScratch.flags;
    entry.pkt.clientTs = this.decodeScratch.clientTs;
    entry.pkt.aimYaw = this.decodeScratch.aimYaw;
    entry.pkt.aimPitch = this.decodeScratch.aimPitch;
    entry.pkt.roll = this.decodeScratch.roll;
    entry.pkt.angVelMag = this.decodeScratch.angVelMag;
    entry.pkt.gesturePower = this.decodeScratch.gesturePower;

    this.writeIdx[slot] = (idx + 1) % RING_SIZE;
    if (this.counts[slot]! < RING_SIZE) {
      this.counts[slot] = this.counts[slot]! + 1;
    }

    this.hzCounters[slot] = this.hzCounters[slot]! + 1;
    if (recvAtMs - this.hzWindowStart >= 1000) {
      const elapsedSec = Math.max(0.2, (recvAtMs - this.hzWindowStart) / 1000);
      for (let s = 0; s < MAX_PLAYERS; s++) {
        this.hzRates[s] = Math.round(this.hzCounters[s]! / elapsedSec);
        this.hzCounters[s] = 0;
      }
      this.hzWindowStart = recvAtMs;
    }
  }

  getSlotInputHz(slot: number): number {
    return this.hzRates[slot] ?? 0;
  }

  /**
   * Samples interpolated aim frames for all 4 player slots with zero heap allocations.
   */
  sampleAll(nowMs: number, connectedMask: number): readonly PlayerAimFrame[] {
    const targetTime = nowMs - INTERP_DELAY_MS;

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const frame = this.frames[slot]!;
      frame.connected = (connectedMask & (1 << slot)) !== 0;
      const count = this.counts[slot]!;
      if (count === 0) continue;

      const ring = this.rings[slot]!;
      const latestIdx = (this.writeIdx[slot]! - 1 + RING_SIZE) % RING_SIZE;
      const latest = ring[latestIdx]!;

      let a = latest;
      let b = latest;
      let foundSpan = false;

      if (count >= 2) {
        for (let i = 0; i < count - 1; i++) {
          const i1 = (latestIdx - i + RING_SIZE) % RING_SIZE;
          const i0 = (latestIdx - i - 1 + RING_SIZE) % RING_SIZE;
          const s1 = ring[i1]!;
          const s0 = ring[i0]!;
          if (s0.recvAtMs <= targetTime && targetTime <= s1.recvAtMs) {
            a = s0;
            b = s1;
            foundSpan = true;
            break;
          }
        }
      }

      let yaw = latest.pkt.aimYaw;
      let pitch = latest.pkt.aimPitch;
      let roll = latest.pkt.roll;

      if (foundSpan && b.recvAtMs > a.recvAtMs) {
        const t = clamp((targetTime - a.recvAtMs) / (b.recvAtMs - a.recvAtMs), 0, 1);
        yaw = a.pkt.aimYaw + (b.pkt.aimYaw - a.pkt.aimYaw) * t;
        pitch = a.pkt.aimPitch + (b.pkt.aimPitch - a.pkt.aimPitch) * t;
        roll = a.pkt.roll + (b.pkt.roll - a.pkt.roll) * t;
      }

      frame.yawRad = yaw;
      frame.pitchRad = pitch;
      frame.rollRad = roll;
      frame.cursorX = clamp(yaw / YAW_FULL_SCALE_RAD, -1, 1);
      frame.cursorY = clamp(pitch / PITCH_FULL_SCALE_RAD, -1, 1);
      frame.angVelMag = latest.pkt.angVelMag;
      frame.primaryDown = (latest.pkt.flags & INPUT_FLAG_PRIMARY) !== 0;
      frame.secondaryDown = (latest.pkt.flags & INPUT_FLAG_SECONDARY) !== 0;
      frame.calibrated = (latest.pkt.flags & INPUT_FLAG_CALIBRATED) !== 0;
      frame.simulator = (latest.pkt.flags & INPUT_FLAG_SIMULATOR) !== 0;
    }

    return this.frames;
  }
}
