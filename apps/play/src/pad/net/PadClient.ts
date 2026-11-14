import type { Room } from "@colyseus/sdk";
import {
  INPUT_PACKET_BYTES,
  MSG_CONTROL,
  MSG_INPUT_BINARY,
  packInputPacket,
  PING_INTERVAL_MS,
  type AvatarId,
  type HapticPattern,
  type InputPacket,
  type PadToServerMessage,
  type PartyRoomStateSnapshot,
  type ServerToClientMessage,
} from "@gyro/shared";
import { createColyseusClient, snapshotRoomState } from "../../common/colyseus-client.js";

const RECONNECT_STORAGE_KEY = "gyro-pad-session";

interface SavedSession {
  reconnectToken: string;
  roomCode: string;
  name: string;
  avatarId: AvatarId;
}

export interface PadHudPayload {
  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  streak: number;
  prompt?: string;
}

export interface PadConnectionEvents {
  onState: (state: PartyRoomStateSnapshot, mySlot: number) => void;
  onStatus: (status: "connecting" | "connected" | "reconnecting" | "disconnected", detail?: string) => void;
  onHaptic: (pattern: HapticPattern) => void;
  onPadHud?: (hud: PadHudPayload) => void;
  onRtt: (rttMs: number) => void;
  onError: (message: string) => void;
}

export class PadClient {
  private readonly client = createColyseusClient();
  private room: Room | null = null;
  private mySlot = -1;
  private pingTimer: number | null = null;
  private readonly packetBuf = new ArrayBuffer(INPUT_PACKET_BYTES);
  private readonly packetView = new DataView(this.packetBuf);
  private readonly packetBytes = new Uint8Array(this.packetBuf);
  private seq = 0;
  private rttMs = 0;

  constructor(private readonly events: PadConnectionEvents) {}

  getSlot(): number {
    return this.mySlot;
  }

  getRttMs(): number {
    return this.rttMs;
  }

  loadSavedSession(): SavedSession | null {
    try {
      const raw = sessionStorage.getItem(RECONNECT_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as SavedSession;
    } catch {
      return null;
    }
  }

  clearSavedSession(): void {
    try {
      sessionStorage.removeItem(RECONNECT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  async tryReconnectSaved(): Promise<boolean> {
    const saved = this.loadSavedSession();
    if (!saved) return false;
    try {
      this.events.onStatus("reconnecting", `Rejoining room ${saved.roomCode}…`);
      const room = await this.client.reconnect(saved.reconnectToken);
      this.bindRoom(room, saved.name, saved.avatarId);
      return true;
    } catch {
      this.clearSavedSession();
      this.events.onStatus("disconnected");
      return false;
    }
  }

  async joinRoom(roomCode: string, name: string, avatarId: AvatarId): Promise<void> {
    const normalized = roomCode.trim().toUpperCase();
    this.events.onStatus("connecting", `Joining room ${normalized}…`);
    try {
      const room = await this.client.joinById(normalized, {
        role: "pad",
        name,
        avatarId,
      });
      this.bindRoom(room, name, avatarId);
    } catch (err) {
      this.events.onStatus("disconnected");
      const msg = err instanceof Error ? err.message : "Could not join room.";
      this.events.onError(msg);
      throw err;
    }
  }

  private bindRoom(room: Room, name: string, avatarId: AvatarId): void {
    this.room = room;
    room.reconnection.enabled = true;
    room.reconnection.minUptime = 0;
    room.reconnection.maxRetries = 15;
    room.reconnection.minDelay = 250;
    room.reconnection.maxDelay = 2500;
    this.events.onStatus("connected");

    room.onMessage(MSG_CONTROL, (msg: ServerToClientMessage) => {
      switch (msg.type) {
        case "srv:welcome": {
          if (typeof msg.slot === "number") {
            this.mySlot = msg.slot;
          }
          if (msg.reconnectToken) {
            try {
              sessionStorage.setItem(
                RECONNECT_STORAGE_KEY,
                JSON.stringify({
                  reconnectToken: msg.reconnectToken,
                  roomCode: msg.roomCode,
                  name,
                  avatarId,
                } satisfies SavedSession),
              );
            } catch {
              // ignore
            }
          }
          this.events.onState(snapshotRoomState(room), this.mySlot);
          break;
        }
        case "srv:pong": {
          this.rttMs = Math.max(0, Math.round(performance.now() - msg.t0));
          this.events.onRtt(this.rttMs);
          break;
        }
        case "srv:haptic":
          this.events.onHaptic(msg.pattern);
          break;
        case "srv:pad_hud":
          this.events.onPadHud?.({
            ammo: msg.ammo,
            maxAmmo: msg.maxAmmo,
            reloading: msg.reloading,
            streak: msg.streak,
            ...(msg.prompt !== undefined ? { prompt: msg.prompt } : {}),
          });
          break;
        case "srv:error":
          this.events.onError(msg.message);
          break;
      }
    });

    room.onStateChange(() => {
      this.events.onState(snapshotRoomState(room), this.mySlot);
    });

    room.onDrop(() => {
      this.events.onStatus("reconnecting", "Connection interrupted — holding slot for 30s…");
    });

    room.onReconnect(() => {
      this.events.onStatus("connected");
    });

    room.onLeave((code) => {
      this.stopPingLoop();
      this.room = null;
      if (code === 4000 || code === 1000) {
        this.clearSavedSession();
      }
      this.events.onStatus("disconnected", code === 4000 ? "Left room." : "Disconnected.");
    });

    this.startPingLoop();
  }

  sendControl(msg: PadToServerMessage): void {
    if (!this.room) return;
    this.room.send(MSG_CONTROL, msg);
  }

  sendInputFrame(
    aimYaw: number,
    aimPitch: number,
    roll: number,
    angVelMag: number,
    gesturePower: number,
    flags: number,
  ): void {
    if (!this.room || this.mySlot < 0) return;
    const pkt: InputPacket = {
      seq: (this.seq = (this.seq + 1) & 0xffff),
      slot: this.mySlot,
      flags,
      clientTs: performance.now(),
      aimYaw,
      aimPitch,
      roll,
      angVelMag,
      gesturePower,
    };
    packInputPacket(this.packetView, pkt);
    this.room.sendBytes(MSG_INPUT_BINARY, this.packetBytes);
  }

  async leave(): Promise<void> {
    this.stopPingLoop();
    this.clearSavedSession();
    if (this.room) {
      await this.room.leave(true);
      this.room = null;
    }
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const sendPing = () => {
      this.sendControl({ type: "net:ping", t0: performance.now() });
    };
    sendPing();
    this.pingTimer = window.setInterval(sendPing, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
