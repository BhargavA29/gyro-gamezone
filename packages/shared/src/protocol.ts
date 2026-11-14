import {
  MAX_DEADZONE_DEG,
  MAX_PLAYERS,
  MAX_SENSITIVITY,
  MIN_DEADZONE_DEG,
  MIN_SENSITIVITY,
  PLAYER_AVATARS,
  type AvatarId,
} from "./constants.js";
import type { GameId, RoomPhase } from "./room-state.js";

export const INPUT_PACKET_BYTES = 28 as const;

export const INPUT_FLAG_PRIMARY = 1 << 0;
export const INPUT_FLAG_SECONDARY = 1 << 1;
export const INPUT_FLAG_CALIBRATED = 1 << 2;
export const INPUT_FLAG_SIMULATOR = 1 << 3;

export interface InputPacket {
  seq: number;
  slot: number;
  flags: number;
  /** Client timestamp in ms (packed at 0.1ms precision in Uint32). */
  clientTs: number;
  /** Calibrated, filtered yaw in radians (right = positive). */
  aimYaw: number;
  /** Calibrated, filtered pitch in radians (up = positive). */
  aimPitch: number;
  /** Roll angle in radians (clockwise = positive). */
  roll: number;
  /** Angular speed magnitude in rad/s. */
  angVelMag: number;
  /** Instant gesture impulse/power [0..+inf). */
  gesturePower: number;
}

export function createEmptyInputPacket(slot = 0): InputPacket {
  return {
    seq: 0,
    slot,
    flags: 0,
    clientTs: 0,
    aimYaw: 0,
    aimPitch: 0,
    roll: 0,
    angVelMag: 0,
    gesturePower: 0,
  };
}

/**
 * Packs an InputPacket into a 28-byte DataView with zero heap allocations.
 */
export function packInputPacket(view: DataView, pkt: InputPacket): void {
  view.setUint16(0, pkt.seq & 0xffff, true);
  view.setUint8(2, pkt.slot & 0xff);
  view.setUint8(3, pkt.flags & 0xff);
  const tenthsMs = Math.max(0, Math.round(pkt.clientTs * 10)) >>> 0;
  view.setUint32(4, tenthsMs, true);
  view.setFloat32(8, pkt.aimYaw, true);
  view.setFloat32(12, pkt.aimPitch, true);
  view.setFloat32(16, pkt.roll, true);
  view.setFloat32(20, pkt.angVelMag, true);
  view.setFloat32(24, pkt.gesturePower, true);
}

/**
 * Unpacks a 28-byte buffer into an existing InputPacket (zero allocations).
 */
export function unpackInputPacket(
  bytes: ArrayBufferLike | ArrayBufferView,
  out: InputPacket,
): boolean {
  const view = ArrayBuffer.isView(bytes)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
  if (view.byteLength < INPUT_PACKET_BYTES) return false;

  const seq = view.getUint16(0, true);
  const slot = view.getUint8(2);
  const flags = view.getUint8(3);
  const clientTs = view.getUint32(4, true) / 10;
  const aimYaw = view.getFloat32(8, true);
  const aimPitch = view.getFloat32(12, true);
  const roll = view.getFloat32(16, true);
  const angVelMag = view.getFloat32(20, true);
  const gesturePower = view.getFloat32(24, true);

  if (
    !Number.isFinite(aimYaw) ||
    !Number.isFinite(aimPitch) ||
    !Number.isFinite(roll) ||
    !Number.isFinite(angVelMag) ||
    !Number.isFinite(gesturePower)
  ) {
    return false;
  }

  out.seq = seq;
  out.slot = slot;
  out.flags = flags;
  out.clientTs = clientTs;
  out.aimYaw = aimYaw;
  out.aimPitch = aimPitch;
  out.roll = roll;
  out.angVelMag = angVelMag;
  out.gesturePower = gesturePower;
  return true;
}

export type GestureKind =
  | "tap"
  | "hold_start"
  | "hold_end"
  | "swipe"
  | "flick"
  | "swing";

export type CalibrationStep = "pending" | "still" | "center" | "range" | "done";

export type HapticPattern = "tap" | "hit" | "combo" | "tension" | "error";

export type PadToServerMessage =
  | {
      type: "pad:join_profile";
      name: string;
      avatarId: AvatarId;
    }
  | {
      type: "pad:calibration";
      step: CalibrationStep;
      ok: boolean;
      noiseFloor?: number;
    }
  | { type: "pad:recenter" }
  | {
      type: "pad:prefs";
      sensitivity: number;
      deadZoneDeg: number;
    }
  | {
      type: "pad:gesture";
      seq: number;
      kind: GestureKind;
      dx: number;
      dy: number;
      power: number;
      clientTs: number;
    }
  | { type: "pad:ready"; ready: boolean }
  | { type: "net:ping"; t0: number };

export type HostToServerMessage =
  | { type: "host:select_game"; gameId: GameId }
  | { type: "host:set_phase"; phase: RoomPhase }
  | { type: "host:start_round"; seed: number }
  | {
      type: "host:round_result";
      scores: Array<{ slot: number; score: number }>;
    }
  | {
      type: "host:haptic";
      slot: number | "all";
      pattern: HapticPattern;
    }
  | { type: "host:kick"; slot: number }
  | { type: "net:ping"; t0: number };

export type ServerErrorCode =
  | "ROOM_FULL"
  | "ROOM_NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_PHASE"
  | "UNAUTHORIZED"
  | "INVALID_PAYLOAD";

export type ServerToClientMessage =
  | {
      type: "srv:welcome";
      role: "host" | "pad";
      slot?: number;
      reconnectToken?: string;
      roomCode: string;
    }
  | {
      type: "srv:error";
      code: ServerErrorCode;
      message: string;
    }
  | {
      type: "srv:pong";
      t0: number;
      serverNow: number;
    }
  | {
      type: "srv:gesture";
      slot: number;
      seq: number;
      kind: GestureKind;
      dx: number;
      dy: number;
      power: number;
      clientTs: number;
    }
  | {
      type: "srv:recenter";
      slot: number;
    }
  | {
      type: "srv:haptic";
      pattern: HapticPattern;
    }
  | {
      type: "srv:round_start";
      gameId: GameId;
      seed: number;
      startsAt: number;
    };

export const MSG_INPUT_BINARY = "i" as const;
export const MSG_CONTROL = "c" as const;

const VALID_GAMES = new Set<GameId>([
  "aim-demo",
  "target-shooting",
  "fruit-slicer",
  "archery",
  "cricket",
]);

const VALID_PHASES = new Set<RoomPhase>([
  "lobby",
  "game_select",
  "calibration",
  "countdown",
  "playing",
  "results",
]);

const VALID_CALIB_STEPS = new Set<CalibrationStep>([
  "pending",
  "still",
  "center",
  "range",
  "done",
]);

const VALID_GESTURES = new Set<GestureKind>([
  "tap",
  "hold_start",
  "hold_end",
  "swipe",
  "flick",
  "swing",
]);

const VALID_HAPTICS = new Set<HapticPattern>([
  "tap",
  "hit",
  "combo",
  "tension",
  "error",
]);

export function sanitizePlayerName(raw: unknown, fallback = "Player"): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 16);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function parsePadMessage(raw: unknown): PadToServerMessage | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "pad:join_profile": {
      const avatarId = PLAYER_AVATARS.includes(raw.avatarId as AvatarId)
        ? (raw.avatarId as AvatarId)
        : "crosshair";
      return {
        type: "pad:join_profile",
        name: sanitizePlayerName(raw.name, "Player"),
        avatarId,
      };
    }
    case "pad:calibration": {
      if (
        typeof raw.step !== "string" ||
        !VALID_CALIB_STEPS.has(raw.step as CalibrationStep) ||
        typeof raw.ok !== "boolean"
      ) {
        return null;
      }
      const msg: PadToServerMessage = {
        type: "pad:calibration",
        step: raw.step as CalibrationStep,
        ok: raw.ok,
      };
      if (isFiniteNum(raw.noiseFloor)) {
        msg.noiseFloor = clamp(raw.noiseFloor, 0, 10);
      }
      return msg;
    }
    case "pad:recenter":
      return { type: "pad:recenter" };
    case "pad:prefs": {
      if (!isFiniteNum(raw.sensitivity) || !isFiniteNum(raw.deadZoneDeg)) {
        return null;
      }
      return {
        type: "pad:prefs",
        sensitivity: clamp(raw.sensitivity, MIN_SENSITIVITY, MAX_SENSITIVITY),
        deadZoneDeg: clamp(raw.deadZoneDeg, MIN_DEADZONE_DEG, MAX_DEADZONE_DEG),
      };
    }
    case "pad:gesture": {
      if (
        !isFiniteNum(raw.seq) ||
        typeof raw.kind !== "string" ||
        !VALID_GESTURES.has(raw.kind as GestureKind) ||
        !isFiniteNum(raw.dx) ||
        !isFiniteNum(raw.dy) ||
        !isFiniteNum(raw.power) ||
        !isFiniteNum(raw.clientTs)
      ) {
        return null;
      }
      return {
        type: "pad:gesture",
        seq: Math.floor(raw.seq) >>> 0,
        kind: raw.kind as GestureKind,
        dx: clamp(raw.dx, -20, 20),
        dy: clamp(raw.dy, -20, 20),
        power: clamp(raw.power, 0, 10),
        clientTs: raw.clientTs,
      };
    }
    case "pad:ready":
      if (typeof raw.ready !== "boolean") return null;
      return { type: "pad:ready", ready: raw.ready };
    case "net:ping":
      if (!isFiniteNum(raw.t0)) return null;
      return { type: "net:ping", t0: raw.t0 };
    default:
      return null;
  }
}

export function parseHostMessage(raw: unknown): HostToServerMessage | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "host:select_game":
      if (typeof raw.gameId !== "string" || !VALID_GAMES.has(raw.gameId as GameId)) {
        return null;
      }
      return { type: "host:select_game", gameId: raw.gameId as GameId };
    case "host:set_phase":
      if (typeof raw.phase !== "string" || !VALID_PHASES.has(raw.phase as RoomPhase)) {
        return null;
      }
      return { type: "host:set_phase", phase: raw.phase as RoomPhase };
    case "host:start_round":
      if (!isFiniteNum(raw.seed)) return null;
      return { type: "host:start_round", seed: Math.floor(raw.seed) >>> 0 };
    case "host:round_result": {
      if (!Array.isArray(raw.scores) || raw.scores.length > MAX_PLAYERS) return null;
      const scores: Array<{ slot: number; score: number }> = [];
      for (const entry of raw.scores) {
        if (
          !isObject(entry) ||
          !isFiniteNum(entry.slot) ||
          !isFiniteNum(entry.score) ||
          entry.slot < 0 ||
          entry.slot >= MAX_PLAYERS
        ) {
          return null;
        }
        scores.push({
          slot: Math.floor(entry.slot),
          score: clamp(Math.round(entry.score), 0, 1_000_000),
        });
      }
      return { type: "host:round_result", scores };
    }
    case "host:haptic": {
      if (typeof raw.pattern !== "string" || !VALID_HAPTICS.has(raw.pattern as HapticPattern)) {
        return null;
      }
      if (raw.slot === "all") {
        return { type: "host:haptic", slot: "all", pattern: raw.pattern as HapticPattern };
      }
      if (!isFiniteNum(raw.slot) || raw.slot < 0 || raw.slot >= MAX_PLAYERS) {
        return null;
      }
      return {
        type: "host:haptic",
        slot: Math.floor(raw.slot),
        pattern: raw.pattern as HapticPattern,
      };
    }
    case "host:kick":
      if (!isFiniteNum(raw.slot) || raw.slot < 0 || raw.slot >= MAX_PLAYERS) return null;
      return { type: "host:kick", slot: Math.floor(raw.slot) };
    case "net:ping":
      if (!isFiniteNum(raw.t0)) return null;
      return { type: "net:ping", t0: raw.t0 };
    default:
      return null;
  }
}
