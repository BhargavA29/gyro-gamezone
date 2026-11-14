import {
  computeAimFromBasis,
  createAimBasis,
  quatAngleBetween,
  type AimBasis,
  type AimPose,
  type Quat,
} from "./quaternion.js";

export interface StillCalibrationSummary {
  /** RMS angular jitter in radians. */
  noiseFloorRad: number;
  /** Stationary acceleration magnitude baseline (~9.81 m/s^2 if gravity included, or ~0 if linear). */
  accelBaseline: number;
  /** Recommended One Euro minCutoff tuned from measured sensor noise. */
  recommendedMinCutoff: number;
  sampleCount: number;
  passed: boolean;
}

export interface RangeCheckSummary {
  minYawRad: number;
  maxYawRad: number;
  minPitchRad: number;
  maxPitchRad: number;
  spanYawDeg: number;
  spanPitchDeg: number;
  passed: boolean;
}

const RAD2DEG = 180 / Math.PI;

/**
 * Computes stationary sensor noise floor and recommended One Euro cutoff
 * from a short "hold still" sample window (~1.2-1.5 seconds).
 */
export function evaluateStillSamples(
  quats: readonly Quat[],
  accelMagnitudes: readonly number[] = [],
): StillCalibrationSummary {
  if (quats.length < 5) {
    return {
      noiseFloorRad: 0,
      accelBaseline: 0,
      recommendedMinCutoff: 1.2,
      sampleCount: quats.length,
      passed: false,
    };
  }

  const anchor = quats[0]!;
  let sqSum = 0;
  let maxExcursion = 0;
  for (let i = 1; i < quats.length; i++) {
    const angle = quatAngleBetween(anchor, quats[i]!);
    sqSum += angle * angle;
    if (angle > maxExcursion) maxExcursion = angle;
  }

  const rmsRad = Math.sqrt(sqSum / (quats.length - 1));

  let accelSum = 0;
  for (let i = 0; i < accelMagnitudes.length; i++) {
    accelSum += accelMagnitudes[i]!;
  }
  const accelBaseline = accelMagnitudes.length > 0 ? accelSum / accelMagnitudes.length : 0;

  // If user moved violently (> 15 deg), fail still check so they re-hold steady.
  const passed = maxExcursion < 15 * (Math.PI / 180);

  // Map RMS jitter to One Euro minCutoff: noisier phones get stronger still smoothing.
  const rmsDeg = rmsRad * RAD2DEG;
  const recommendedMinCutoff =
    rmsDeg > 0.35 ? 0.75 : rmsDeg > 0.15 ? 1.0 : 1.35;

  return {
    noiseFloorRad: rmsRad,
    accelBaseline,
    recommendedMinCutoff,
    sampleCount: quats.length,
    passed,
  };
}

/**
 * Tracks live aim range during step 3 ("sweep left/right/up/down") to verify
 * orientation sensors respond smoothly across comfortable wrist motion.
 */
export class RangeCheckTracker {
  private minYaw = 0;
  private maxYaw = 0;
  private minPitch = 0;
  private maxPitch = 0;
  private readonly poseScratch: AimPose = { yaw: 0, pitch: 0, roll: 0 };

  constructor(private readonly basis: AimBasis) {}

  reset(): void {
    this.minYaw = 0;
    this.maxYaw = 0;
    this.minPitch = 0;
    this.maxPitch = 0;
  }

  pushQuat(q: Quat): RangeCheckSummary {
    computeAimFromBasis(this.basis, q, this.poseScratch);
    return this.pushAim(this.poseScratch.yaw, this.poseScratch.pitch);
  }

  pushAim(yawRad: number, pitchRad: number): RangeCheckSummary {
    if (yawRad < this.minYaw) this.minYaw = yawRad;
    if (yawRad > this.maxYaw) this.maxYaw = yawRad;
    if (pitchRad < this.minPitch) this.minPitch = pitchRad;
    if (pitchRad > this.maxPitch) this.maxPitch = pitchRad;

    const spanYawDeg = (this.maxYaw - this.minYaw) * RAD2DEG;
    const spanPitchDeg = (this.maxPitch - this.minPitch) * RAD2DEG;

    return {
      minYawRad: this.minYaw,
      maxYawRad: this.maxYaw,
      minPitchRad: this.minPitch,
      maxPitchRad: this.maxPitch,
      spanYawDeg,
      spanPitchDeg,
      // Require at least 18 degrees horizontal and 12 degrees vertical movement
      passed: spanYawDeg >= 18 && spanPitchDeg >= 12,
    };
  }
}

export function createCenterBasis(centerQuat: Quat): AimBasis {
  return createAimBasis(centerQuat);
}
