export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AimBasis {
  refQuat: Quat;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

export interface AimPose {
  yaw: number;
  pitch: number;
  roll: number;
}

const DEG2RAD = Math.PI / 180;

export function quatIdentity(out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.w = 1;
  return out;
}

export function quatCopy(a: Quat, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  out.w = a.w;
  return out;
}

export function quatNormalize(q: Quat, out: Quat = q): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-12) {
    return quatIdentity(out);
  }
  const inv = 1 / len;
  out.x = q.x * inv;
  out.y = q.y * inv;
  out.z = q.z * inv;
  out.w = q.w * inv;
  return out;
}

export function quatConjugate(q: Quat, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  out.x = -q.x;
  out.y = -q.y;
  out.z = -q.z;
  out.w = q.w;
  return out;
}

export function quatMultiply(a: Quat, b: Quat, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;

  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatRotateVec3(
  q: Quat,
  v: Vec3,
  out: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;

  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Angle (radians) between two unit quaternions in [0, pi].
 */
export function quatAngleBetween(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

/**
 * Converts W3C DeviceOrientation Euler angles (intrinsic Z-X'-Y'': alpha, beta, gamma in deg)
 * plus screen orientation angle (0, 90, 180, 270 deg) into a world-frame unit quaternion.
 *
 * World frame: +X East, +Y North, +Z Up.
 * Device frame (portrait): +X screen right, +Y screen top, +Z out of glass.
 */
export function quatFromDeviceOrientation(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg = 0,
  out: Quat = { x: 0, y: 0, z: 0, w: 1 },
): Quat {
  const halfA = alphaDeg * DEG2RAD * 0.5;
  const halfB = betaDeg * DEG2RAD * 0.5;
  const halfG = gammaDeg * DEG2RAD * 0.5;

  const sA = Math.sin(halfA);
  const cA = Math.cos(halfA);
  const sB = Math.sin(halfB);
  const cB = Math.cos(halfB);
  const sG = Math.sin(halfG);
  const cG = Math.cos(halfG);

  // q = qz(alpha) * qx(beta) * qy(gamma)
  // First qzx = qz(a) * qx(b):
  const zxX = cA * sB;
  const zxY = sA * sB;
  const zxZ = sA * cB;
  const zxW = cA * cB;

  // Then q = qzx * qy(g):
  out.x = zxX * cG - zxZ * sG;
  out.y = zxY * cG + zxW * sG;
  out.z = zxZ * cG + zxX * sG;
  out.w = zxW * cG - zxY * sG;

  if (screenAngleDeg !== 0) {
    const halfS = -screenAngleDeg * DEG2RAD * 0.5;
    const sS = Math.sin(halfS);
    const cS = Math.cos(halfS);
    const qx = out.x;
    const qy = out.y;
    const qz = out.z;
    const qw = out.w;
    // Post-multiply by qz(-screenAngle)
    out.x = qx * cS + qy * sS;
    out.y = qy * cS - qx * sS;
    out.z = qw * sS + qz * cS;
    out.w = qw * cS - qz * sS;
  }

  return quatNormalize(out, out);
}

/**
 * Converts a Generic Sensor API [x, y, z, w] quaternion (and optional screen orientation)
 * into the same world-frame device quaternion convention.
 */
export function quatFromGenericSensor(
  raw: readonly [number, number, number, number],
  screenAngleDeg = 0,
  out: Quat = { x: 0, y: 0, z: 0, w: 1 },
): Quat {
  out.x = raw[0];
  out.y = raw[1];
  out.z = raw[2];
  out.w = raw[3];

  if (screenAngleDeg !== 0) {
    const halfS = -screenAngleDeg * DEG2RAD * 0.5;
    const sS = Math.sin(halfS);
    const cS = Math.cos(halfS);
    const qx = out.x;
    const qy = out.y;
    const qz = out.z;
    const qw = out.w;
    out.x = qx * cS + qy * sS;
    out.y = qy * cS - qx * sS;
    out.z = qw * sS + qz * cS;
    out.w = qw * cS - qz * sS;
  }

  return quatNormalize(out, out);
}

/**
 * Captures a gravity-aligned horizontal screen basis from the user's "point at center"
 * reference quaternion. This prevents wrist grip tilt (flat tray vs vertical remote)
 * from causing diagonal crosstalk when sweeping left/right.
 */
export function createAimBasis(refQuat: Quat): AimBasis {
  const normRef = quatNormalize({ ...refQuat });
  const deviceRight = quatRotateVec3(normRef, { x: 1, y: 0, z: 0 });
  const rightXYLen = Math.hypot(deviceRight.x, deviceRight.y);

  // World Up is (0, 0, 1). Project device right onto horizontal plane if non-degenerate.
  let right: Vec3;
  if (rightXYLen > 0.15) {
    right = {
      x: deviceRight.x / rightXYLen,
      y: deviceRight.y / rightXYLen,
      z: 0,
    };
  } else {
    // Fallback if phone was held completely on its side: use device -Z projected horizontally
    const deviceBack = quatRotateVec3(normRef, { x: 0, y: 0, z: -1 });
    const fLen = Math.hypot(deviceBack.x, deviceBack.y) || 1;
    const fwdFallback = { x: deviceBack.x / fLen, y: deviceBack.y / fLen, z: 0 };
    // right = fwd x up = (fy, -fx, 0)
    right = { x: fwdFallback.y, y: -fwdFallback.x, z: 0 };
  }

  const up: Vec3 = { x: 0, y: 0, z: 1 };
  // forward = up x right
  const forward: Vec3 = {
    x: up.y * right.z - up.z * right.y,
    y: up.z * right.x - up.x * right.z,
    z: up.x * right.y - up.y * right.x,
  };

  return {
    refQuat: normRef,
    right,
    up,
    forward,
  };
}

// Reusable scratch objects to keep computeAimFromBasis allocation-free in 60 Hz hot paths.
const _invRef: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _worldDelta: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _pointer: Vec3 = { x: 0, y: 1, z: 0 };
const _curRight: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * Computes relative aim (yaw, pitch, roll in radians) without gimbal lock.
 * - yaw: +right, -left
 * - pitch: +up, -down
 * - roll: +clockwise wrist twist
 */
export function computeAimFromBasis(
  basis: AimBasis,
  currentQuat: Quat,
  out: AimPose = { yaw: 0, pitch: 0, roll: 0 },
): AimPose {
  quatConjugate(basis.refQuat, _invRef);
  // Left-multiply in world space: worldDelta = current * inv(ref)
  quatMultiply(currentQuat, _invRef, _worldDelta);
  quatNormalize(_worldDelta, _worldDelta);

  quatRotateVec3(_worldDelta, basis.forward, _pointer);

  const pRight =
    _pointer.x * basis.right.x + _pointer.y * basis.right.y + _pointer.z * basis.right.z;
  const pUp =
    _pointer.x * basis.up.x + _pointer.y * basis.up.y + _pointer.z * basis.up.z;
  const pFwd =
    _pointer.x * basis.forward.x +
    _pointer.y * basis.forward.y +
    _pointer.z * basis.forward.z;

  out.yaw = Math.atan2(pRight, pFwd);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, pUp)));

  // Twist/roll around forward ray from current device +X rotated against basis
  quatRotateVec3(currentQuat, { x: 1, y: 0, z: 0 }, _curRight);
  const rDotUp = _curRight.x * basis.up.x + _curRight.y * basis.up.y + _curRight.z * basis.up.z;
  const rDotRight =
    _curRight.x * basis.right.x + _curRight.y * basis.right.y + _curRight.z * basis.right.z;
  out.roll = Math.atan2(-rDotUp, rDotRight);

  return out;
}
