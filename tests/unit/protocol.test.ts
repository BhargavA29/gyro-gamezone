import { describe, expect, it } from "vitest";
import {
  createEmptyInputPacket,
  INPUT_FLAG_CALIBRATED,
  INPUT_FLAG_PRIMARY,
  INPUT_PACKET_BYTES,
  packInputPacket,
  parseHostMessage,
  parsePadMessage,
  sanitizePlayerName,
  unpackInputPacket,
} from "@gyro/shared";

describe("protocol packing and validation", () => {
  it("roundtrips compact 28-byte InputPacket cleanly", () => {
    const buf = new ArrayBuffer(INPUT_PACKET_BYTES);
    const view = new DataView(buf);
    const src = {
      seq: 4219,
      slot: 2,
      flags: INPUT_FLAG_PRIMARY | INPUT_FLAG_CALIBRATED,
      clientTs: 12345.6,
      aimYaw: -0.4321,
      aimPitch: 0.2718,
      roll: 0.111,
      angVelMag: 3.45,
      gesturePower: 0.88,
    };
    packInputPacket(view, src);

    const out = createEmptyInputPacket();
    expect(unpackInputPacket(buf, out)).toBe(true);
    expect(out.seq).toBe(4219);
    expect(out.slot).toBe(2);
    expect(out.flags).toBe(src.flags);
    expect(out.clientTs).toBeCloseTo(12345.6, 1);
    expect(out.aimYaw).toBeCloseTo(-0.4321, 4);
    expect(out.aimPitch).toBeCloseTo(0.2718, 4);
    expect(out.roll).toBeCloseTo(0.111, 4);
    expect(out.angVelMag).toBeCloseTo(3.45, 4);
    expect(out.gesturePower).toBeCloseTo(0.88, 4);
  });

  it("rejects short buffers and NaN packets", () => {
    const out = createEmptyInputPacket();
    expect(unpackInputPacket(new ArrayBuffer(12), out)).toBe(false);

    const bad = new ArrayBuffer(INPUT_PACKET_BYTES);
    const view = new DataView(bad);
    view.setFloat32(8, Number.NaN, true);
    expect(unpackInputPacket(bad, out)).toBe(false);
  });

  it("validates and clamps pad and host control messages", () => {
    const profile = parsePadMessage({
      type: "pad:join_profile",
      name: "  Ace\u0000PlayerVeryLongName123  ",
      avatarId: "orbit",
    });
    expect(profile).toEqual({
      type: "pad:join_profile",
      name: "AcePlayerVeryLon",
      avatarId: "orbit",
    });

    const prefs = parsePadMessage({
      type: "pad:prefs",
      sensitivity: 99,
      deadZoneDeg: -3,
    });
    expect(prefs).toEqual({
      type: "pad:prefs",
      sensitivity: 2.5,
      deadZoneDeg: 0,
    });

    expect(parsePadMessage({ type: "host:kick", slot: 0 })).toBeNull();
    expect(parseHostMessage({ type: "host:select_game", gameId: "archery" })).toEqual({
      type: "host:select_game",
      gameId: "archery",
    });
    expect(parseHostMessage({ type: "host:select_game", gameId: "nope" })).toBeNull();
    expect(sanitizePlayerName("")).toBe("Player");
  });
});
