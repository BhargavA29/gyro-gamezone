export const MAX_PLAYERS = 4 as const;

export const RECONNECT_GRACE_MS = 30_000 as const;

export const ROOM_CODE_LENGTH = 4 as const;

/** Unambiguous uppercase alphabet (omits 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ" as const;

export const INPUT_SEND_HZ = 60 as const;

export const INPUT_SEND_INTERVAL_MS = 1000 / INPUT_SEND_HZ;

export const PING_INTERVAL_MS = 2000 as const;

export const ROOM_IDLE_CLEANUP_MS = 900_000;

export const PLAYER_AVATARS = ["prism", "crosshair", "chevron", "orbit"] as const;

export type AvatarId = (typeof PLAYER_AVATARS)[number];

export interface PlayerSlotPalette {
  slot: 0 | 1 | 2 | 3;
  label: string;
  hex: string;
  textOnHex: string;
  defaultAvatar: AvatarId;
}

export const PLAYER_SLOT_PALETTE: readonly PlayerSlotPalette[] = [
  { slot: 0, label: "Signal Red", hex: "#FF4D2E", textOnHex: "#0D0F14", defaultAvatar: "crosshair" },
  { slot: 1, label: "Volt Amber", hex: "#FFB800", textOnHex: "#0D0F14", defaultAvatar: "prism" },
  { slot: 2, label: "Cyan Relay", hex: "#19D3FF", textOnHex: "#0D0F14", defaultAvatar: "chevron" },
  { slot: 3, label: "Acid Mint", hex: "#3CE87A", textOnHex: "#0D0F14", defaultAvatar: "orbit" },
] as const;

export const DEFAULT_SENSITIVITY = 1.15;
export const MIN_SENSITIVITY = 0.5;
export const MAX_SENSITIVITY = 2.5;

export const DEFAULT_DEADZONE_DEG = 0.4;
export const MIN_DEADZONE_DEG = 0.0;
export const MAX_DEADZONE_DEG = 5.0;

/** Max accepted messages per second per client for anti-spam rate limiting. */
export const SERVER_RATE_LIMITS = {
  inputPerSec: 95,
  controlPerSec: 30,
  gesturePerSec: 40,
} as const;
