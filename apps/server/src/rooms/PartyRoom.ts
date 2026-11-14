import crypto from "node:crypto";
import { type Client, matchMaker, Room, ServerError } from "@colyseus/core";
import {
  DEFAULT_DEADZONE_DEG,
  DEFAULT_SENSITIVITY,
  GAME_CATALOG,
  INPUT_PACKET_BYTES,
  MAX_PLAYERS,
  MSG_CONTROL,
  MSG_INPUT_BINARY,
  parseHostMessage,
  parsePadMessage,
  PLAYER_AVATARS,
  PLAYER_SLOT_PALETTE,
  RECONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_IDLE_CLEANUP_MS,
  sanitizePlayerName,
  SERVER_RATE_LIMITS,
  type AvatarId,
  type ServerToClientMessage,
} from "@gyro/shared";
import { TokenBucketLimiter } from "../security/rateLimit.js";
import {
  PartyState,
  type PartyStateInstance,
  PlayerSchema,
  type PlayerSchemaInstance,
} from "../state/PartyState.js";

interface JoinOptions {
  role?: "host" | "pad";
  name?: string;
  avatarId?: AvatarId;
}

interface ClientSessionMeta {
  role: "host" | "pad";
  slot?: 0 | 1 | 2 | 3;
  inputLimiter: TokenBucketLimiter;
  controlLimiter: TokenBucketLimiter;
  gestureLimiter: TokenBucketLimiter;
}

function randomRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

export class PartyRoom extends Room<{ state: PartyStateInstance }> {
  override maxClients = MAX_PLAYERS + 1; // 1 host + up to 4 phones
  override autoDispose = true;
  override patchRate = 50; // 20 Hz room-state delta patches; 60 Hz input uses raw sendBytes

  private hostSessionId: string | null = null;
  private sessions = new Map<string, ClientSessionMeta>();
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs = Date.now();

  private async generateUniqueRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = randomRoomCode();
      const existing = await matchMaker.findRoomsByIds([candidate]);
      if (!existing.has(candidate)) {
        return candidate;
      }
    }
    // Fallback with timestamp suffix if unlikely collision occurs
    return randomRoomCode();
  }

  override async onCreate(): Promise<void> {
    const code = await this.generateUniqueRoomCode();
    this.roomId = code;
    this.state = new PartyState();
    this.state.roomCode = code;
    this.state.phase = "lobby";
    this.state.selectedGame = "aim-demo";
    this.state.difficulty = "arcade";
    this.state.phaseStartedAt = Date.now();

    this.registerMessageHandlers();

    this.idleCheckInterval = setInterval(() => {
      if (Date.now() - this.lastActivityMs > ROOM_IDLE_CLEANUP_MS) {
        void this.disconnect(4000);
      }
    }, 60_000);
  }

  override onAuth(_client: Client, options: JoinOptions): JoinOptions {
    const role = options?.role === "host" ? "host" : "pad";

    if (role === "host") {
      if (this.hostSessionId !== null) {
        throw new ServerError(4009, "Room already has a host screen.");
      }
      return { role: "host" };
    }

    if (this.findFreeSlot() === null) {
      throw new ServerError(4003, "Room is full (4 players max).");
    }

    const avatarId = PLAYER_AVATARS.includes(options?.avatarId as AvatarId)
      ? (options.avatarId as AvatarId)
      : undefined;

    return {
      role: "pad",
      name: sanitizePlayerName(options?.name, "Player"),
      ...(avatarId ? { avatarId } : {}),
    };
  }

  override onJoin(client: Client, options: JoinOptions): void {
    this.touchActivity();
    const role = options?.role === "host" ? "host" : "pad";

    if (role === "host") {
      this.hostSessionId = client.sessionId;
      this.state.hostConnected = true;
      this.sessions.set(client.sessionId, {
        role: "host",
        inputLimiter: new TokenBucketLimiter(SERVER_RATE_LIMITS.inputPerSec),
        controlLimiter: new TokenBucketLimiter(SERVER_RATE_LIMITS.controlPerSec),
        gestureLimiter: new TokenBucketLimiter(SERVER_RATE_LIMITS.gesturePerSec),
      });

      this.sendTyped(client, {
        type: "srv:welcome",
        role: "host",
        roomCode: this.state.roomCode,
        reconnectToken: `${this.roomId}:${client.reconnectionToken}`,
      });
      return;
    }

    const slot = this.findFreeSlot();
    if (slot === null) {
      this.sendTyped(client, {
        type: "srv:error",
        code: "ROOM_FULL",
        message: "Room already has 4 players.",
      });
      client.leave(4003, "ROOM_FULL");
      return;
    }

    const palette = PLAYER_SLOT_PALETTE[slot]!;
    const player = new PlayerSchema();
    player.slot = slot;
    player.playerId = client.sessionId;
    player.name = sanitizePlayerName(options?.name, `Player ${slot + 1}`);
    player.colorHex = palette.hex;
    player.avatarId = options?.avatarId ?? palette.defaultAvatar;
    player.connected = true;
    player.disconnectedAt = 0;
    player.ready = false;
    player.calibrated = false;
    player.calibrationStep = "pending";
    player.sensitivity = DEFAULT_SENSITIVITY;
    player.deadZoneDeg = DEFAULT_DEADZONE_DEG;
    player.score = 0;
    player.wins = 0;

    this.state.players.set(client.sessionId, player);
    this.sessions.set(client.sessionId, {
      role: "pad",
      slot,
      inputLimiter: new TokenBucketLimiter(SERVER_RATE_LIMITS.inputPerSec, 120),
      controlLimiter: new TokenBucketLimiter(SERVER_RATE_LIMITS.controlPerSec, 40),
      gestureLimiter: new TokenBucketLimiter(SERVER_RATE_LIMITS.gesturePerSec, 50),
    });

    this.sendTyped(client, {
      type: "srv:welcome",
      role: "pad",
      slot,
      roomCode: this.state.roomCode,
      reconnectToken: `${this.roomId}:${client.reconnectionToken}`,
    });
  }

  override async onDrop(client: Client): Promise<void> {
    const meta = this.sessions.get(client.sessionId);
    if (!meta) return;

    if (meta.role === "host") {
      this.state.hostConnected = false;
    } else {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.connected = false;
        player.disconnectedAt = Date.now();
      }
    }

    try {
      await this.allowReconnection(client, RECONNECT_GRACE_MS / 1000);
    } catch {
      // Grace period expired; Colyseus will invoke onLeave automatically.
    }
  }

  override onReconnect(client: Client): void {
    this.touchActivity();
    const meta = this.sessions.get(client.sessionId);
    if (!meta) return;

    if (meta.role === "host") {
      this.state.hostConnected = true;
      this.sendTyped(client, {
        type: "srv:welcome",
        role: "host",
        roomCode: this.state.roomCode,
        reconnectToken: `${this.roomId}:${client.reconnectionToken}`,
      });
      return;
    }

    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = true;
      player.disconnectedAt = 0;
      this.sendTyped(client, {
        type: "srv:welcome",
        role: "pad",
        slot: player.slot,
        roomCode: this.state.roomCode,
        reconnectToken: `${this.roomId}:${client.reconnectionToken}`,
      });
    }
  }

  override onLeave(client: Client): void {
    const meta = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    if (!meta) return;

    if (meta.role === "host") {
      if (this.hostSessionId === client.sessionId) {
        this.hostSessionId = null;
        this.state.hostConnected = false;
      }
      return;
    }

    this.state.players.delete(client.sessionId);
  }

  override onDispose(): void {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  private registerMessageHandlers(): void {
    // 60 Hz compact binary controller frames
    this.onMessageBytes(MSG_INPUT_BINARY, (client, bytes) => {
      const meta = this.sessions.get(client.sessionId);
      if (!meta || meta.role !== "pad" || meta.slot === undefined) return;
      if (!meta.inputLimiter.allow()) return;
      if (!bytes || bytes.byteLength !== INPUT_PACKET_BYTES) return;

      this.touchActivity();
      const host = this.getHostClient();
      if (!host) return;

      // Clone and overwrite slot byte on server so pads cannot spoof another seat
      const frame = new Uint8Array(bytes);
      frame[2] = meta.slot;
      host.sendBytes(MSG_INPUT_BINARY, frame);
    });

    // Typed control & gesture JSON messages
    this.onMessage(MSG_CONTROL, (client, payload: unknown) => {
      const meta = this.sessions.get(client.sessionId);
      if (!meta) return;
      this.touchActivity();

      if (meta.role === "host") {
        if (!meta.controlLimiter.allow()) {
          this.sendError(client, "RATE_LIMITED", "Too many control messages.");
          return;
        }
        const msg = parseHostMessage(payload);
        if (!msg) {
          this.sendError(client, "INVALID_PAYLOAD", "Malformed host message.");
          return;
        }
        this.handleHostMessage(client, msg);
        return;
      }

      const padMsg = parsePadMessage(payload);
      if (!padMsg) {
        this.sendError(client, "INVALID_PAYLOAD", "Malformed controller message.");
        return;
      }

      const limiter =
        padMsg.type === "pad:gesture" ? meta.gestureLimiter : meta.controlLimiter;
      if (!limiter.allow()) {
        return;
      }

      this.handlePadMessage(client, meta.slot!, padMsg);
    });
  }

  private handleHostMessage(
    client: Client,
    msg: NonNullable<ReturnType<typeof parseHostMessage>>,
  ): void {
    switch (msg.type) {
      case "net:ping":
        this.sendTyped(client, { type: "srv:pong", t0: msg.t0, serverNow: Date.now() });
        break;
      case "host:select_game": {
        const entry = GAME_CATALOG.find((g) => g.id === msg.gameId);
        this.state.selectedGame = msg.gameId;
        this.state.roundDurationMs = entry?.roundDurationMs ?? 60_000;
        break;
      }
      case "host:set_phase": {
        if (this.countdownTimer) {
          clearTimeout(this.countdownTimer);
          this.countdownTimer = null;
        }
        this.state.phase = msg.phase;
        this.state.phaseStartedAt = Date.now();
        if (msg.phase === "lobby" || msg.phase === "game_select") {
          for (const [, p] of this.state.players) {
            p.score = 0;
          }
        }
        break;
      }
      case "host:start_round": {
        if (this.countdownTimer) {
          clearTimeout(this.countdownTimer);
          this.countdownTimer = null;
        }
        const entry = GAME_CATALOG.find((g) => g.id === this.state.selectedGame);
        this.state.roundDurationMs = entry?.roundDurationMs ?? 60_000;

        for (const [, p] of this.state.players) {
          p.score = 0;
        }

        // Aim-demo jumps straight into playing without a 3-2-1 gate
        if (this.state.selectedGame === "aim-demo") {
          const now = Date.now();
          this.state.phase = "playing";
          this.state.phaseStartedAt = now;
          this.broadcastTyped({
            type: "srv:round_start",
            gameId: this.state.selectedGame,
            seed: msg.seed,
            startsAt: now,
          });
          break;
        }

        const now = Date.now();
        this.state.phase = "countdown";
        this.state.phaseStartedAt = now;
        const startsAt = now + 3000;
        this.broadcastTyped({
          type: "srv:round_start",
          gameId: this.state.selectedGame,
          seed: msg.seed,
          startsAt,
        });

        this.countdownTimer = setTimeout(() => {
          this.state.phase = "playing";
          this.state.phaseStartedAt = Date.now();
          this.countdownTimer = null;
        }, 3000);
        break;
      }
      case "host:round_result": {
        let bestScore = -1;
        for (const row of msg.scores) {
          if (row.score > bestScore) bestScore = row.score;
        }
        for (const [, p] of this.state.players) {
          const entry = msg.scores.find((s) => s.slot === p.slot);
          if (entry) {
            p.score = entry.score;
            if (bestScore > 0 && entry.score === bestScore) {
              p.wins += 1;
            }
          }
        }
        this.state.phase = "results";
        this.state.phaseStartedAt = Date.now();
        break;
      }
      case "host:set_difficulty": {
        this.state.difficulty = msg.difficulty;
        break;
      }
      case "host:pad_hud": {
        for (const c of this.clients) {
          const m = this.sessions.get(c.sessionId);
          if (!m || m.role !== "pad") continue;
          if (msg.slot === "all" || m.slot === msg.slot) {
            this.sendTyped(c, {
              type: "srv:pad_hud",
              ammo: msg.ammo,
              maxAmmo: msg.maxAmmo,
              reloading: msg.reloading,
              streak: msg.streak,
              ...(msg.prompt !== undefined ? { prompt: msg.prompt } : {}),
            });
          }
        }
        break;
      }
      case "host:haptic": {
        for (const c of this.clients) {
          const m = this.sessions.get(c.sessionId);
          if (!m || m.role !== "pad") continue;
          if (msg.slot === "all" || m.slot === msg.slot) {
            this.sendTyped(c, { type: "srv:haptic", pattern: msg.pattern });
          }
        }
        break;
      }
      case "host:kick": {
        for (const [sid, player] of this.state.players) {
          if (player.slot === msg.slot) {
            const target = this.clients.find((c) => c.sessionId === sid);
            if (target) {
              target.leave(4000, "Kicked by host");
            } else {
              this.state.players.delete(sid);
            }
            break;
          }
        }
        break;
      }
    }
  }

  private handlePadMessage(
    client: Client,
    slot: 0 | 1 | 2 | 3,
    msg: NonNullable<ReturnType<typeof parsePadMessage>>,
  ): void {
    const player = this.state.players.get(client.sessionId);

    switch (msg.type) {
      case "net:ping":
        this.sendTyped(client, { type: "srv:pong", t0: msg.t0, serverNow: Date.now() });
        break;
      case "pad:join_profile":
        if (player) {
          player.name = msg.name;
          player.avatarId = msg.avatarId;
        }
        break;
      case "pad:calibration":
        if (player) {
          player.calibrationStep = msg.step;
          player.calibrated = msg.step === "done" && msg.ok;
        }
        break;
      case "pad:recenter": {
        const host = this.getHostClient();
        if (host) {
          this.sendTyped(host, { type: "srv:recenter", slot });
        }
        break;
      }
      case "pad:prefs":
        if (player) {
          player.sensitivity = msg.sensitivity;
          player.deadZoneDeg = msg.deadZoneDeg;
        }
        break;
      case "pad:ready":
        if (player) {
          player.ready = msg.ready;
        }
        break;
      case "pad:gesture": {
        const host = this.getHostClient();
        if (host) {
          this.sendTyped(host, {
            type: "srv:gesture",
            slot,
            seq: msg.seq,
            kind: msg.kind,
            dx: msg.dx,
            dy: msg.dy,
            power: msg.power,
            clientTs: msg.clientTs,
          });
        }
        break;
      }
    }
  }

  private findFreeSlot(): 0 | 1 | 2 | 3 | null {
    const used = new Set<number>();
    for (const [, player] of this.state.players) {
      used.add(player.slot);
    }
    for (const s of [0, 1, 2, 3] as const) {
      if (!used.has(s)) return s;
    }
    return null;
  }

  private getHostClient(): Client | undefined {
    if (!this.hostSessionId) return undefined;
    return this.clients.find((c) => c.sessionId === this.hostSessionId);
  }

  private sendTyped(client: Client, msg: ServerToClientMessage): void {
    client.send(MSG_CONTROL, msg);
  }

  private broadcastTyped(msg: ServerToClientMessage): void {
    this.broadcast(MSG_CONTROL, msg);
  }

  private sendError(
    client: Client,
    code: Extract<ServerToClientMessage, { type: "srv:error" }>["code"],
    message: string,
  ): void {
    this.sendTyped(client, { type: "srv:error", code, message });
  }

  private touchActivity(): void {
    this.lastActivityMs = Date.now();
  }
}

export type PartyPlayer = PlayerSchemaInstance;
