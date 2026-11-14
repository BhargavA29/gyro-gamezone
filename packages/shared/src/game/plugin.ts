import type { GestureKind, HapticPattern } from "../protocol.js";
import type { DifficultyPreset, GameId, PlayerSlotState, RoomPhase } from "../room-state.js";

export interface PlayerAimFrame {
  slot: 0 | 1 | 2 | 3;
  connected: boolean;
  /** Normalized screen coordinates [-1..+1] (0,0 = screen center). */
  cursorX: number;
  cursorY: number;
  /** Raw calibrated angles in radians. */
  yawRad: number;
  pitchRad: number;
  rollRad: number;
  /** Angular speed (rad/s). */
  angVelMag: number;
  primaryDown: boolean;
  secondaryDown: boolean;
  calibrated: boolean;
  simulator: boolean;
}

export interface PlayerGestureEvent {
  slot: 0 | 1 | 2 | 3;
  kind: GestureKind;
  dx: number;
  dy: number;
  power: number;
  clientTs: number;
}

export interface GameHudApi {
  setRoundTimer(remainingMs: number | null): void;
  setTutorialVisible(visible: boolean, lines?: readonly string[]): void;
  announce(text: string): void;
  updateScoreboard(players: ReadonlyArray<{ slot: number; name: string; colorHex: string; score: number }>): void;
  setPlayerAmmoHud?(
    players: ReadonlyArray<{
      slot: number;
      ammo: number;
      maxAmmo: number;
      reloading: boolean;
      streak: number;
    }>,
  ): void;
}

export interface GameAudioApi {
  play(
    cue:
      | "tick"
      | "go"
      | "pop"
      | "shot"
      | "dry_fire"
      | "low_ammo"
      | "reload_start"
      | "reload"
      | "hazard"
      | "hit"
      | "bullseye"
      | "gold_spawn"
      | "gold_hit"
      | "combo"
      | "miss"
      | "slice"
      | "swipe"
      | "bomb_fuse"
      | "bomb_boom"
      | "frenzy"
      | "bow_release"
      | "bat_hit"
      | "end",
  ): void;
  startMusic?(bpm?: number): void;
  stopMusic?(): void;
}

export interface GameFxApi {
  addScreenShake(intensity: number): void;
  triggerHitStop(durationMs: number): void;
}

export interface GameHostContext {
  container: HTMLElement;
  players: readonly PlayerSlotState[];
  seed: number;
  difficulty: DifficultyPreset;
  getPhase(): RoomPhase;
  hud: GameHudApi;
  audio: GameAudioApi;
  fx: GameFxApi;
  sendHaptic(slot: number | "all", pattern: HapticPattern): void;
  sendPadHud?(
    slot: number | "all",
    payload: {
      ammo: number;
      maxAmmo: number;
      reloading: boolean;
      streak: number;
      prompt?: string;
    },
  ): void;
  finishRound(scores: Array<{ slot: number; score: number }>): void;
}

export interface GamePlugin {
  readonly id: GameId;
  init(ctx: GameHostContext): Promise<void> | void;
  /** Fixed-timestep simulation step (dt in seconds). */
  update(dt: number, inputs: readonly PlayerAimFrame[]): void;
  /** Frame render with interpolation alpha [0..1]. */
  render(alpha: number): void;
  onGesture?(event: PlayerGestureEvent): void;
  onResize?(width: number, height: number, dpr: number): void;
  getScores(): Array<{ slot: number; score: number }>;
  dispose(): void;
}
