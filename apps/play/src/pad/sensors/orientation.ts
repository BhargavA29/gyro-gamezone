import {
  applyDeadZone,
  clamp,
  computeAimFromBasis,
  createAimBasis,
  DEFAULT_DEADZONE_DEG,
  DEFAULT_SENSITIVITY,
  evaluateStillSamples,
  OneEuroFilter,
  quatAngleBetween,
  quatCopy,
  quatFromDeviceOrientation,
  quatFromGenericSensor,
  quatIdentity,
  RangeCheckTracker,
  type AimBasis,
  type AimPose,
  type Quat,
  type RangeCheckSummary,
  type StillCalibrationSummary,
} from "@gyro/shared";

export type SensorBackend =
  | "generic-relative"
  | "generic-absolute"
  | "deviceorientation"
  | "touch-fallback"
  | "none";

export type PermissionStateKind = "unknown" | "prompt" | "granted" | "denied" | "unsupported";

export interface SensorDebugSnapshot {
  backend: SensorBackend;
  permission: PermissionStateKind;
  rawEulerDeg: { alpha: number; beta: number; gamma: number };
  quat: Quat;
  rawAimDeg: { yaw: number; pitch: number; roll: number };
  filteredAimDeg: { yaw: number; pitch: number; roll: number };
  angVelMag: number;
  linearAccelMag: number;
  noiseFloorDeg: number;
  sampleHz: number;
  calibrated: boolean;
}

interface GenericOrientationSensor extends EventTarget {
  quaternion?: [number, number, number, number];
  start(): void;
  stop(): void;
}

interface GenericGyroscope extends EventTarget {
  x?: number;
  y?: number;
  z?: number;
  start(): void;
  stop(): void;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function getScreenAngleDeg(): number {
  if (typeof screen !== "undefined" && screen.orientation && typeof screen.orientation.angle === "number") {
    return screen.orientation.angle;
  }
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

export class GyroControllerPipeline {
  private backend: SensorBackend = "none";
  private permission: PermissionStateKind = "unknown";
  private started = false;

  private orientationSensor: GenericOrientationSensor | null = null;
  private gyroSensor: GenericGyroscope | null = null;

  private readonly curQuat: Quat = quatIdentity();
  private readonly prevQuat: Quat = quatIdentity();
  private hasQuatSample = false;
  private lastQuatTs = 0;

  private basis: AimBasis = createAimBasis(this.curQuat);
  private readonly rawPose: AimPose = { yaw: 0, pitch: 0, roll: 0 };
  private readonly filteredPose: AimPose = { yaw: 0, pitch: 0, roll: 0 };

  private readonly rawEuler = { alpha: 0, beta: 0, gamma: 0 };
  private angVelMag = 0;
  private linearAccelMag = 0;
  private accelBaseline = 0;
  private noiseFloorRad = 0;
  private sampleHz = 0;
  private hzCounter = 0;
  private hzWindowStart = 0;

  private sensitivity = DEFAULT_SENSITIVITY;
  private deadZoneDeg = DEFAULT_DEADZONE_DEG;
  private calibrated = false;

  private readonly yawFilter = new OneEuroFilter({ minCutoff: 1.1, beta: 1.5, dCutoff: 1.0 });
  private readonly pitchFilter = new OneEuroFilter({ minCutoff: 1.1, beta: 1.5, dCutoff: 1.0 });
  private readonly rollFilter = new OneEuroFilter({ minCutoff: 1.4, beta: 1.2, dCutoff: 1.0 });

  private stillCollecting = false;
  private stillQuats: Quat[] = [];
  private stillAccels: number[] = [];
  private rangeTracker: RangeCheckTracker | null = null;

  private touchYawOffset = 0;
  private touchPitchOffset = 0;

  private motionListeners: Array<(angVel: number, accelMag: number, ax: number, ay: number, az: number, ts: number) => void> = [];

  private boundDeviceOrientation = (e: DeviceOrientationEvent) => this.onDeviceOrientation(e);
  private boundDeviceMotion = (e: DeviceMotionEvent) => this.onDeviceMotion(e);

  constructor() {
    this.detectInitialPermissionState();
  }

  private detectInitialPermissionState(): void {
    const doe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof doe?.requestPermission === "function") {
      this.permission = "prompt";
    } else if ("RelativeOrientationSensor" in window || "DeviceOrientationEvent" in window) {
      this.permission = "granted";
    } else {
      this.permission = "unsupported";
    }
  }

  getPermissionState(): PermissionStateKind {
    return this.permission;
  }

  getBackend(): SensorBackend {
    return this.backend;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  setPreferences(sensitivity: number, deadZoneDeg: number): void {
    this.sensitivity = clamp(sensitivity, 0.5, 2.5);
    this.deadZoneDeg = clamp(deadZoneDeg, 0, 5);
  }

  onMotionSample(
    cb: (angVel: number, accelMag: number, ax: number, ay: number, az: number, ts: number) => void,
  ): () => void {
    this.motionListeners.push(cb);
    return () => {
      this.motionListeners = this.motionListeners.filter((fn) => fn !== cb);
    };
  }

  /**
   * Must be called inside a user click/tap handler on iOS Safari.
   * Requests both orientation & motion permissions synchronously in the same gesture tick.
   */
  async requestPermissionsAndStart(): Promise<{ granted: boolean; backend: SensorBackend }> {
    const doe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const dme = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };

    if (typeof doe?.requestPermission === "function") {
      try {
        const pOrient = doe.requestPermission();
        const pMotion =
          typeof dme?.requestPermission === "function"
            ? dme.requestPermission()
            : Promise.resolve("granted" as const);
        const [resO, resM] = await Promise.all([pOrient, pMotion]);
        if (resO !== "granted" && resM !== "granted") {
          this.permission = "denied";
          this.backend = "touch-fallback";
          return { granted: false, backend: this.backend };
        }
        this.permission = "granted";
      } catch {
        this.permission = "denied";
        this.backend = "touch-fallback";
        return { granted: false, backend: this.backend };
      }
    }

    await this.startSensors();
    return { granted: this.permission !== "denied", backend: this.backend };
  }

  async startSensors(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.hzWindowStart = performance.now();

    // Always attach devicemotion for linear acceleration & rotationRate gestures
    if ("DeviceMotionEvent" in window) {
      window.addEventListener("devicemotion", this.boundDeviceMotion, { passive: true });
    }

    // Prefer Generic Sensor API RelativeOrientationSensor (immune to magnetometer interference)
    const startedGeneric = await this.tryStartGenericSensors();
    if (!startedGeneric) {
      this.startDeviceOrientationFallback();
    }
  }

  private async tryStartGenericSensors(): Promise<boolean> {
    const w = window as unknown as {
      RelativeOrientationSensor?: new (opts?: { frequency?: number; referenceFrame?: string }) => GenericOrientationSensor;
      AbsoluteOrientationSensor?: new (opts?: { frequency?: number; referenceFrame?: string }) => GenericOrientationSensor;
      Gyroscope?: new (opts?: { frequency?: number }) => GenericGyroscope;
    };

    const SensorCtor = w.RelativeOrientationSensor ?? w.AbsoluteOrientationSensor;
    if (!SensorCtor) return false;

    try {
      const sensor = new SensorCtor({ frequency: 60, referenceFrame: "device" });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("Generic sensor timeout"));
          }
        }, 650);

        sensor.addEventListener("reading", () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            resolve();
          }
          if (sensor.quaternion) {
            this.pushOrientationQuat(
              quatFromGenericSensor(sensor.quaternion, getScreenAngleDeg()),
              performance.now(),
            );
          }
        });

        sensor.addEventListener("error", () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            reject(new Error("Generic sensor error"));
          }
        });

        sensor.start();
      });

      this.orientationSensor = sensor;
      this.backend =
        SensorCtor === w.RelativeOrientationSensor ? "generic-relative" : "generic-absolute";
      this.permission = "granted";

      if (w.Gyroscope) {
        try {
          const gyro = new w.Gyroscope({ frequency: 60 });
          gyro.addEventListener("reading", () => {
            const gx = gyro.x ?? 0;
            const gy = gyro.y ?? 0;
            const gz = gyro.z ?? 0;
            this.angVelMag = Math.hypot(gx, gy, gz);
          });
          gyro.start();
          this.gyroSensor = gyro;
        } catch {
          // Optional gyroscope sensor; angular velocity fallback works from quat delta
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private startDeviceOrientationFallback(): void {
    if (!("DeviceOrientationEvent" in window)) {
      this.backend = "touch-fallback";
      this.permission = "unsupported";
      return;
    }
    this.backend = "deviceorientation";
    window.addEventListener("deviceorientation", this.boundDeviceOrientation, { passive: true });

    // If desktop browser fires null orientation or no event after 900ms, switch cleanly to touch-fallback
    window.setTimeout(() => {
      if (!this.hasQuatSample && this.backend === "deviceorientation") {
        this.backend = "touch-fallback";
      }
    }, 900);
  }

  private onDeviceOrientation(e: DeviceOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) {
      return;
    }
    this.backend = "deviceorientation";
    this.permission = "granted";
    this.rawEuler.alpha = e.alpha;
    this.rawEuler.beta = e.beta;
    this.rawEuler.gamma = e.gamma;

    const q = quatFromDeviceOrientation(e.alpha, e.beta, e.gamma, getScreenAngleDeg());
    this.pushOrientationQuat(q, performance.now());
  }

  private onDeviceMotion(e: DeviceMotionEvent): void {
    const ts = performance.now();
    if (
      e.rotationRate &&
      e.rotationRate.alpha !== null &&
      e.rotationRate.beta !== null &&
      e.rotationRate.gamma !== null
    ) {
      const rx = e.rotationRate.alpha * DEG2RAD;
      const ry = e.rotationRate.beta * DEG2RAD;
      const rz = e.rotationRate.gamma * DEG2RAD;
      this.angVelMag = Math.hypot(rx, ry, rz);
    }

    const lin = e.acceleration;
    const grav = e.accelerationIncludingGravity;
    let ax = 0;
    let ay = 0;
    let az = 0;
    let mag = 0;
    if (lin && lin.x !== null && lin.y !== null && lin.z !== null) {
      ax = lin.x;
      ay = lin.y;
      az = lin.z;
      mag = Math.hypot(ax, ay, az);
    } else if (grav && grav.x !== null && grav.y !== null && grav.z !== null) {
      ax = grav.x;
      ay = grav.y;
      az = grav.z;
      const rawMag = Math.hypot(ax, ay, az);
      const baseline = this.accelBaseline > 1 ? this.accelBaseline : 9.81;
      mag = Math.abs(rawMag - baseline);
    }

    this.linearAccelMag = mag;
    if (this.stillCollecting) {
      this.stillAccels.push(
        grav && grav.x !== null && grav.y !== null && grav.z !== null
          ? Math.hypot(grav.x, grav.y, grav.z)
          : mag,
      );
    }

    for (const cb of this.motionListeners) {
      cb(this.angVelMag, mag, ax, ay, az, ts);
    }
  }

  private pushOrientationQuat(q: Quat, tsMs: number): void {
    if (this.hasQuatSample && !this.gyroSensor) {
      const dtSec = Math.max(0.004, (tsMs - this.lastQuatTs) / 1000);
      if (dtSec < 0.25) {
        const dAngle = quatAngleBetween(this.prevQuat, q);
        // Fallback angular speed estimate if DeviceMotion rotationRate isn't present
        if (this.angVelMag === 0 || this.backend !== "deviceorientation") {
          this.angVelMag = dAngle / dtSec;
        }
      }
    }

    quatCopy(q, this.curQuat);
    quatCopy(q, this.prevQuat);
    this.lastQuatTs = tsMs;
    this.hasQuatSample = true;

    this.hzCounter += 1;
    if (tsMs - this.hzWindowStart >= 1000) {
      this.sampleHz = Math.round((this.hzCounter * 1000) / (tsMs - this.hzWindowStart));
      this.hzCounter = 0;
      this.hzWindowStart = tsMs;
    }

    if (this.stillCollecting) {
      this.stillQuats.push({ ...q });
    }
    if (this.rangeTracker) {
      this.rangeTracker.pushQuat(q);
    }
  }

  /** Touch-drag delta used when hardware gyro is unavailable or denied. */
  nudgeTouchAim(dxNorm: number, dyNorm: number): void {
    this.touchYawOffset = clamp(this.touchYawOffset + dxNorm * 0.9, -0.95, 0.95);
    this.touchPitchOffset = clamp(this.touchPitchOffset - dyNorm * 0.65, -0.65, 0.65);
    if (this.rangeTracker) {
      this.rangeTracker.pushAim(this.touchYawOffset, this.touchPitchOffset);
    }
  }

  beginStillCalibration(): void {
    this.stillCollecting = true;
    this.stillQuats = [];
    this.stillAccels = [];
  }

  finishStillCalibration(): StillCalibrationSummary {
    this.stillCollecting = false;
    // In touch-fallback mode without gyro samples, succeed cleanly with defaults
    if (this.backend === "touch-fallback" && this.stillQuats.length < 5) {
      this.noiseFloorRad = 0;
      this.accelBaseline = 0;
      return {
        noiseFloorRad: 0,
        accelBaseline: 0,
        recommendedMinCutoff: 1.15,
        sampleCount: 0,
        passed: true,
      };
    }

    const summary = evaluateStillSamples(this.stillQuats, this.stillAccels);
    this.noiseFloorRad = summary.noiseFloorRad;
    if (summary.accelBaseline > 1) {
      this.accelBaseline = summary.accelBaseline;
    }
    this.yawFilter.setParams({ minCutoff: summary.recommendedMinCutoff });
    this.pitchFilter.setParams({ minCutoff: summary.recommendedMinCutoff });
    return summary;
  }

  captureCenterAndStartRange(): void {
    this.recenter();
    this.rangeTracker = new RangeCheckTracker(this.basis);
  }

  pollRangeCheck(): RangeCheckSummary {
    if (!this.rangeTracker) {
      this.rangeTracker = new RangeCheckTracker(this.basis);
    }
    return this.backend === "touch-fallback" && !this.hasQuatSample
      ? this.rangeTracker.pushAim(this.touchYawOffset, this.touchPitchOffset)
      : this.rangeTracker.pushQuat(this.curQuat);
  }

  markCalibrated(done: boolean): void {
    this.calibrated = done;
    this.rangeTracker = null;
  }

  recenter(): void {
    if (this.hasQuatSample) {
      this.basis = createAimBasis(this.curQuat);
    }
    this.touchYawOffset = 0;
    this.touchPitchOffset = 0;
    const now = performance.now();
    this.yawFilter.reset(0, now);
    this.pitchFilter.reset(0, now);
    this.rollFilter.reset(0, now);
  }

  sampleAim(tsMs = performance.now()): AimPose {
    if (this.hasQuatSample) {
      computeAimFromBasis(this.basis, this.curQuat, this.rawPose);
    } else {
      this.rawPose.yaw = this.touchYawOffset;
      this.rawPose.pitch = this.touchPitchOffset;
      this.rawPose.roll = 0;
    }

    const dzRad = this.deadZoneDeg * DEG2RAD;
    const dzYaw = applyDeadZone(this.rawPose.yaw, dzRad);
    const dzPitch = applyDeadZone(this.rawPose.pitch, dzRad);

    const fy = this.yawFilter.filter(dzYaw, tsMs) * this.sensitivity;
    const fp = this.pitchFilter.filter(dzPitch, tsMs) * this.sensitivity;
    const fr = this.rollFilter.filter(this.rawPose.roll, tsMs);

    this.filteredPose.yaw = clamp(fy, -1.35, 1.35);
    this.filteredPose.pitch = clamp(fp, -1.1, 1.1);
    this.filteredPose.roll = fr;
    return this.filteredPose;
  }

  getAngVelMag(): number {
    return this.angVelMag;
  }

  getLinearAccelMag(): number {
    return this.linearAccelMag;
  }

  getDebugSnapshot(): SensorDebugSnapshot {
    const pose = this.sampleAim(performance.now());
    return {
      backend: this.backend,
      permission: this.permission,
      rawEulerDeg: { ...this.rawEuler },
      quat: { ...this.curQuat },
      rawAimDeg: {
        yaw: this.rawPose.yaw * RAD2DEG,
        pitch: this.rawPose.pitch * RAD2DEG,
        roll: this.rawPose.roll * RAD2DEG,
      },
      filteredAimDeg: {
        yaw: pose.yaw * RAD2DEG,
        pitch: pose.pitch * RAD2DEG,
        roll: pose.roll * RAD2DEG,
      },
      angVelMag: this.angVelMag,
      linearAccelMag: this.linearAccelMag,
      noiseFloorDeg: this.noiseFloorRad * RAD2DEG,
      sampleHz: this.sampleHz,
      calibrated: this.calibrated,
    };
  }

  dispose(): void {
    this.started = false;
    window.removeEventListener("deviceorientation", this.boundDeviceOrientation);
    window.removeEventListener("devicemotion", this.boundDeviceMotion);
    try {
      this.orientationSensor?.stop();
      this.gyroSensor?.stop();
    } catch {
      // Ignore sensor stop failures on teardown
    }
    this.orientationSensor = null;
    this.gyroSensor = null;
  }
}
