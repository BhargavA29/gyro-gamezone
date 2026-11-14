import type { Room } from "@colyseus/sdk";
import {
  MSG_CONTROL,
  MSG_INPUT_BINARY,
  PING_INTERVAL_MS,
  type GestureKind,
  type HostToServerMessage,
  type PartyRoomStateSnapshot,
  type PlayerGestureEvent,
  type ServerToClientMessage,
} from "@gyro/shared";
import { createColyseusClient, snapshotRoomState } from "../../common/colyseus-client.js";
import { HostInputBuffer } from "./InputBuffer.js";

export interface HostNetEvents {
  onState: (state: PartyRoomStateSnapshot) => void;
  onGesture: (event: PlayerGestureEvent) => void;
  onRecenter: (slot: number) => void;
  onRtt: (rttMs: number) => void;
  onStatus: (status: "connecting" | "connected" | "reconnecting" | "disconnected") => void;
  onError: (msg: string) => void;
}

export class HostClient {
  private readonly client = createColyseusClient();
  readonly inputBuffer = new HostInputBuffer();
  private room: Room | null = null;
  private pingTimer: number | null = null;
  private rttMs = 0;

  constructor(private readonly events: HostNetEvents) {}

  getRttMs(): number {
    return this.rttMs;
  }

  async createRoom(): Promise<PartyRoomStateSnapshot> {
    this.events.onStatus("connecting");
    const room = await this.client.create("party", { role: "host" });
    this.room = room;
    room.reconnection.enabled = true;
    room.reconnection.minUptime = 0;
    room.reconnection.maxRetries = 12;

    room.onMessage(MSG_INPUT_BINARY, (bytes: Uint8Array) => {
      if (bytes instanceof Uint8Array) {
        this.inputBuffer.pushBinaryPacket(bytes, performance.now());
      } else if (bytes && typeof (bytes as ArrayBuffer).byteLength === "number") {
        this.inputBuffer.pushBinaryPacket(new Uint8Array(bytes as ArrayBuffer), performance.now());
      }
    });

    room.onMessage(MSG_CONTROL, (msg: ServerToClientMessage) => {
      switch (msg.type) {
        case "srv:pong":
          this.rttMs = Math.max(0, Math.round(performance.now() - msg.t0));
          this.events.onRtt(this.rttMs);
          break;
        case "srv:gesture":
          this.events.onGesture({
            slot: msg.slot as 0 | 1 | 2 | 3,
            kind: msg.kind as GestureKind,
            dx: msg.dx,
            dy: msg.dy,
            power: msg.power,
            clientTs: msg.clientTs,
          });
          break;
        case "srv:recenter":
          this.events.onRecenter(msg.slot);
          break;
        case "srv:error":
          this.events.onError(msg.message);
          break;
      }
    });

    room.onStateChange(() => {
      this.events.onState(snapshotRoomState(room));
    });

    room.onDrop(() => {
      this.events.onStatus("reconnecting");
    });

    room.onReconnect(() => {
      this.events.onStatus("connected");
    });

    room.onLeave(() => {
      this.stopPingLoop();
      this.events.onStatus("disconnected");
    });

    this.events.onStatus("connected");
    this.startPingLoop();
    const initial = snapshotRoomState(room);
    this.events.onState(initial);
    return initial;
  }

  sendControl(msg: HostToServerMessage): void {
    if (!this.room) return;
    this.room.send(MSG_CONTROL, msg);
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const ping = () => this.sendControl({ type: "net:ping", t0: performance.now() });
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopPingLoop();
    if (this.room) {
      await this.room.leave(true);
      this.room = null;
    }
  }
}
