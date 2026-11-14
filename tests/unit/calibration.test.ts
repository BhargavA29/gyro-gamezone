import { describe, expect, it } from "vitest";
import {
  createCenterBasis,
  evaluateStillSamples,
  quatFromDeviceOrientation,
  RangeCheckTracker,
} from "@gyro/shared";

describe("calibration helpers", () => {
  it("passes still check for steady samples and fails when moved wildly", () => {
    const steady = Array.from({ length: 30 }, (_, i) =>
      quatFromDeviceOrientation(90 + (i % 2) * 0.05, 45, 0),
    );
    const steadyRes = evaluateStillSamples(steady, Array(30).fill(9.81));
    expect(steadyRes.passed).toBe(true);
    expect(steadyRes.accelBaseline).toBeCloseTo(9.81, 2);

    const shaky = [
      quatFromDeviceOrientation(90, 45, 0),
      quatFromDeviceOrientation(120, 45, 0),
      quatFromDeviceOrientation(95, 65, 0),
      quatFromDeviceOrientation(110, 45, 0),
      quatFromDeviceOrientation(130, 50, 0),
    ];
    const shakyRes = evaluateStillSamples(shaky);
    expect(shakyRes.passed).toBe(false);
  });

  it("verifies horizontal and vertical range span", () => {
    const center = quatFromDeviceOrientation(180, 45, 0);
    const tracker = new RangeCheckTracker(createCenterBasis(center));

    expect(tracker.pushQuat(center).passed).toBe(false);
    tracker.pushQuat(quatFromDeviceOrientation(165, 45, 0)); // +15 deg right
    tracker.pushQuat(quatFromDeviceOrientation(195, 45, 0)); // -15 deg left -> 30 deg span
    expect(tracker.pushQuat(quatFromDeviceOrientation(180, 55, 0)).passed).toBe(false);
    const res = tracker.pushQuat(quatFromDeviceOrientation(180, 35, 0)); // 20 deg pitch span
    expect(res.spanYawDeg).toBeGreaterThan(28);
    expect(res.spanPitchDeg).toBeGreaterThan(18);
    expect(res.passed).toBe(true);
  });
});
