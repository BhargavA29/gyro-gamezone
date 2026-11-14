import { schema, type SchemaType, t } from "@colyseus/schema";
import {
  DEFAULT_DEADZONE_DEG,
  DEFAULT_SENSITIVITY,
  type AvatarId,
  type CalibrationStep,
  type GameId,
  type RoomPhase,
} from "@gyro/shared";

export const PlayerSchema = schema(
  {
    slot: t.uint8<0 | 1 | 2 | 3>().default(0),
    playerId: t.string().default(""),
    name: t.string().default("Player"),
    colorHex: t.string().default("#FF4D2E"),
    avatarId: t.string<AvatarId>().default("crosshair"),
    connected: t.boolean().default(true),
    /** Epoch ms when disconnected (0 when connected). */
    disconnectedAt: t.float64().default(0),
    ready: t.boolean().default(false),
    calibrated: t.boolean().default(false),
    calibrationStep: t.string<CalibrationStep>().default("pending"),
    sensitivity: t.float32().default(DEFAULT_SENSITIVITY),
    deadZoneDeg: t.float32().default(DEFAULT_DEADZONE_DEG),
    score: t.uint32().default(0),
    wins: t.uint16().default(0),
  },
  "PlayerSchema",
);

export type PlayerSchemaInstance = SchemaType<typeof PlayerSchema>;

export const PartyState = schema(
  {
    roomCode: t.string().default(""),
    phase: t.string<RoomPhase>().default("lobby"),
    selectedGame: t.string<GameId>().default("aim-demo"),
    phaseStartedAt: t.float64().default(0),
    roundDurationMs: t.uint32().default(0),
    hostConnected: t.boolean().default(false),
    players: t.map(PlayerSchema),
  },
  "PartyState",
);

export type PartyStateInstance = SchemaType<typeof PartyState>;
