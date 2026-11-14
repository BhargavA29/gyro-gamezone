import { describe, expect, it } from "vitest";
import {
  computeAimFromBasis,
  createAimBasis,
  quatFromDeviceOrientation,
  quatFromGenericSensor,
} from "@gyro/shared";

const RAD2DEG = 180 / Math.PI;

describe("quaternion aim math", () => {
  it("zeros yaw, pitch, and roll at the calibrated center pose", () => {
    const ref = quatFromDeviceOrientation(42, 48, 0, 0);
    const basis = createAimBasis(ref);
    const pose = computeAimFromBasis(basis, ref);
    expect(pose.yaw).toBeCloseTo(0, 5);
    expect(pose.pitch).toBeCloseTo(0, 5);
    expect(pose.roll).toBeCloseTo(0, 5);
  });

  it("maps horizontal wrist turn right (+yaw) without pitch crosstalk at 45 deg grip tilt", () => {
    const ref = quatFromDeviceOrientation(100, 45, 0, 0);
    const basis = createAimBasis(ref);

    // Turning right decreases alpha by 25 deg
    const turnedRight = quatFromDeviceOrientation(75, 45, 0, 0);
    const pose = computeAimFromBasis(basis, turnedRight);

    expect(pose.yaw * RAD2DEG).toBeCloseTo(25, 2);
    expect(pose.pitch * RAD2DEG).toBeCloseTo(0, 2);
  });

  it("maps horizontal turn cleanly even at 85 deg steep vertical grip without gimbal lock", () => {
    const ref = quatFromDeviceOrientation(200, 85, 0, 0);
    const basis = createAimBasis(ref);

    const turnedLeft = quatFromDeviceOrientation(220, 85, 0, 0);
    const pose = computeAimFromBasis(basis, turnedLeft);

    expect(pose.yaw * RAD2DEG).toBeCloseTo(-20, 2);
    expect(pose.pitch * RAD2DEG).toBeCloseTo(0, 2);
  });

  it("maps upward tilt (+beta) to positive pitch regardless of initial heading", () => {
    const ref = quatFromDeviceOrientation(137, 40, 0, 0);
    const basis = createAimBasis(ref);

    const tiltedUp = quatFromDeviceOrientation(137, 62, 0, 0);
    const pose = computeAimFromBasis(basis, tiltedUp);

    expect(pose.pitch * RAD2DEG).toBeCloseTo(22, 2);
    expect(pose.yaw * RAD2DEG).toBeCloseTo(0, 2);
  });

  it("handles generic sensor quaternion with screen orientation compensation", () => {
    const q = quatFromGenericSensor([0, 0, 0, 1], 90);
    const len = Math.hypot(q.x, q.y, q.z, q.w);
    expect(len).toBeCloseTo(1, 6);
  });
});
