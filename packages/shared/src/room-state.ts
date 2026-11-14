import type { AvatarId } from "./constants.js";

export type RoomPhase =
  | "lobby"
  | "game_select"
  | "calibration"
  | "countdown"
  | "playing"
  | "results";

export type GameId =
  | "aim-demo"
  | "target-shooting"
  | "fruit-slicer"
  | "archery"
  | "cricket";

export interface GameCatalogEntry {
  id: GameId;
  slug: string;
  title: string;
  tagline: string;
  roundDurationMs: number;
  maxPlayers: number;
  minPlayers: number;
  controlsSummary: string[];
  /** Hidden until unlocked or shown specifically for sensor verification. */
  isCalibrationDemo?: boolean;
}

export const GAME_CATALOG: readonly GameCatalogEntry[] = [
  {
    id: "aim-demo",
    slug: "aim-demo",
    title: "Aim Dot Calibration Lab",
    tagline: "Verify gyro tracking, latency, tap bursts, and recenter live.",
    roundDurationMs: 0,
    minPlayers: 1,
    maxPlayers: 4,
    controlsSummary: [
      "Aim with wrist rotation",
      "Tap screen to pulse target",
      "Flick wrist to trigger shockwave",
    ],
    isCalibrationDemo: true,
  },
  {
    id: "target-shooting",
    slug: "target-shooting",
    title: "Target Shooting",
    tagline: "Snap aim across pop-up arcade targets, flick to reload, chain combos.",
    roundDurationMs: 60_000,
    minPlayers: 1,
    maxPlayers: 4,
    controlsSummary: [
      "Point phone to aim reticle",
      "Tap anywhere to fire",
      "Flick wrist up or down to reload",
    ],
  },
  {
    id: "fruit-slicer",
    slug: "fruit-slicer",
    title: "Fruit Slicer",
    tagline: "Sweep your blade with gyro or touch swipes; dodge arcade bombs.",
    roundDurationMs: 60_000,
    minPlayers: 1,
    maxPlayers: 4,
    controlsSummary: [
      "Sweep gyro or swipe across pad to slice",
      "Slice multiple fruits in one arc for combo",
      "Avoid bombs",
    ],
  },
  {
    id: "archery",
    slug: "archery",
    title: "Archery",
    tagline: "Single target, 6 ends, rising crosswind & moving rail — tally the highest total.",
    roundDurationMs: 75_000,
    minPlayers: 1,
    maxPlayers: 4,
    controlsSummary: [
      "Hold pad to draw 3D recurve bow under haptic tension",
      "Compensate gyro aim for crosswind across 6 ends",
      "Release at full draw to group arrows & score End 6 (2×)",
    ],
  },
  {
    id: "cricket",
    slug: "cricket",
    title: "Cricket",
    tagline: "Time your phone swing against AI deliveries to smash boundaries.",
    roundDurationMs: 90_000,
    minPlayers: 1,
    maxPlayers: 4,
    controlsSummary: [
      "Hold phone like a bat handle",
      "Swing as the ball enters the strike zone",
      "Tilt bat face to steer shots",
    ],
  },
] as const;

export interface PlayerSlotState {
  slot: 0 | 1 | 2 | 3;
  playerId: string;
  name: string;
  colorHex: string;
  avatarId: AvatarId;
  connected: boolean;
  disconnectedAt: number | null;
  ready: boolean;
  calibrated: boolean;
  calibrationStep: "pending" | "still" | "center" | "range" | "done";
  sensitivity: number;
  deadZoneDeg: number;
  score: number;
  wins: number;
}

export type DifficultyPreset = "casual" | "arcade" | "pro";

export interface DifficultyMeta {
  id: DifficultyPreset;
  label: string;
  shortDesc: string;
}

export const DIFFICULTY_PRESETS: readonly DifficultyMeta[] = [
  {
    id: "casual",
    label: "Chill",
    shortDesc: "Gentle opening pace, larger targets, soft difficulty ramp",
  },
  {
    id: "arcade",
    label: "Arcade",
    shortDesc: "Balanced rhythm, steady 60s wave escalation",
  },
  {
    id: "pro",
    label: "Turbo",
    shortDesc: "Fast wave transitions, tighter bullseyes, 1.25× points",
  },
];

export interface PartyRoomStateSnapshot {
  roomCode: string;
  phase: RoomPhase;
  selectedGame: GameId;
  difficulty: DifficultyPreset;
  phaseStartedAt: number;
  roundDurationMs: number;
  hostConnected: boolean;
  players: PlayerSlotState[];
}
