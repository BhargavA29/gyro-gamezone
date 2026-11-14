import { Client, type Room } from "@colyseus/sdk";
import type {
  GameId,
  PartyRoomStateSnapshot,
  PlayerSlotState,
  RoomPhase,
} from "@gyro/shared";

declare const __DEV_LAN_ORIGIN__: string;

export function getColyseusEndpoint(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim();
  }
  return `${window.location.origin}/colyseus`;
}

export function createColyseusClient(): Client {
  return new Client(getColyseusEndpoint());
}

/**
 * Returns the best phone-reachable base origin for QR codes:
 * - User-saved custom tunnel URL (e.g., ngrok) if provided
 * - Otherwise if host is viewed on localhost/127.0.0.1 in dev, swaps to detected LAN IPv4
 * - Otherwise uses current window.location.origin
 */
export function resolveJoinOrigin(customOrigin?: string): string {
  if (customOrigin && customOrigin.trim().length > 0) {
    return customOrigin.trim().replace(/\/+$/, "");
  }
  const { hostname, origin } = window.location;
  if (
    (hostname === "localhost" || hostname === "127.0.0.1") &&
    typeof __DEV_LAN_ORIGIN__ === "string" &&
    __DEV_LAN_ORIGIN__.length > 0
  ) {
    return __DEV_LAN_ORIGIN__;
  }
  return origin;
}

interface RawStateMap {
  forEach?: (cb: (entry: Record<string, unknown>) => void) => void;
}

interface RawRoomState {
  roomCode?: unknown;
  phase?: unknown;
  selectedGame?: unknown;
  phaseStartedAt?: unknown;
  roundDurationMs?: unknown;
  hostConnected?: unknown;
  players?: RawStateMap;
}

/**
 * Converts Colyseus Schema Room state safely into a typed snapshot.
 */
export function snapshotRoomState(room: Room): PartyRoomStateSnapshot {
  const raw = room.state as RawRoomState | undefined;
  const players: PlayerSlotState[] = [];

  if (raw?.players && typeof raw.players.forEach === "function") {
    raw.players.forEach((p: Record<string, unknown>) => {
      players.push({
        slot: (Number(p.slot ?? 0)) as 0 | 1 | 2 | 3,
        playerId: String(p.playerId ?? ""),
        name: String(p.name ?? "Player"),
        colorHex: String(p.colorHex ?? "#FF4D2E"),
        avatarId: (p.avatarId ?? "crosshair") as PlayerSlotState["avatarId"],
        connected: Boolean(p.connected),
        disconnectedAt: p.disconnectedAt ? Number(p.disconnectedAt) : null,
        ready: Boolean(p.ready),
        calibrated: Boolean(p.calibrated),
        calibrationStep: (p.calibrationStep ?? "pending") as PlayerSlotState["calibrationStep"],
        sensitivity: Number(p.sensitivity ?? 1.15),
        deadZoneDeg: Number(p.deadZoneDeg ?? 0.4),
        score: Number(p.score ?? 0),
        wins: Number(p.wins ?? 0),
      });
    });
  }

  players.sort((a, b) => a.slot - b.slot);

  return {
    roomCode: String(raw?.roomCode ?? room.roomId ?? ""),
    phase: (raw?.phase ?? "lobby") as RoomPhase,
    selectedGame: (raw?.selectedGame ?? "aim-demo") as GameId,
    phaseStartedAt: Number(raw?.phaseStartedAt ?? 0),
    roundDurationMs: Number(raw?.roundDurationMs ?? 0),
    hostConnected: Boolean(raw?.hostConnected),
    players,
  };
}
