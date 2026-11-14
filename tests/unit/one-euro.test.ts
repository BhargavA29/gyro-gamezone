import { describe, expect, it } from "vitest";
import { applyDeadZone, OneEuroFilter } from "@gyro/shared";

describe("OneEuroFilter", () => {
  it("attenuates stationary high-frequency jitter while staying responsive to fast steps", () => {
    const filter = new OneEuroFilter({ minCutoff: 1.0, beta: 1.5, dCutoff: 1.0 });

    // Stationary noisy signal oscillating +/- 0.05 rad at 60Hz
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      const noise = (i % 2 === 0 ? 1 : -1) * 0.05;
      const out = filter.filter(noise, i * 16.6667);
      if (i > 15) {
        maxDev = Math.max(maxDev, Math.abs(out));
      }
    }
    expect(maxDev).toBeLessThan(0.02);

    // Fast step jump to 1.0 rad: should converge rapidly within 6 frames (100ms)
    let stepped = 0;
    for (let i = 60; i < 66; i++) {
      stepped = filter.filter(1.0, i * 16.6667);
    }
    expect(stepped).toBeGreaterThan(0.85);
  });

  it("applies smooth deadzone without jump discontinuity", () => {
    const dz = 0.02;
    expect(applyDeadZone(0.015, dz)).toBe(0);
    expect(applyDeadZone(-0.015, dz)).toBe(0);
    expect(applyDeadZone(0.05, dz)).toBeCloseTo(0.03, 6);
    expect(applyDeadZone(-0.05, dz)).toBeCloseTo(-0.03, 6);
  });
});
