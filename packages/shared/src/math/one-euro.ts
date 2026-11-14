/**
 * One Euro Filter (Casiez, Roussel, Vogel — CHI 2012).
 * Provides heavy smoothing when still (low jitter) and minimal lag during rapid flicks.
 */
export interface OneEuroParams {
  /** Minimum cutoff frequency in Hz (lower = smoother when still). Default ~1.1 Hz. */
  minCutoff: number;
  /** Speed coefficient in 1/rad units (higher = less lag during fast motion). Default 1.5 for radian angles. */
  beta: number;
  /** Derivative cutoff frequency in Hz. Default 1.0 Hz. */
  dCutoff: number;
}

const TWO_PI = Math.PI * 2;

function smoothingFactor(te: number, cutoff: number): number {
  const r = TWO_PI * cutoff * te;
  return r / (r + 1);
}

function expSmoothing(alpha: number, x: number, prev: number): number {
  return alpha * x + (1 - alpha) * prev;
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private initialized = false;
  private xPrev = 0;
  private dxPrev = 0;
  private lastTsMs = 0;

  constructor(params: Partial<OneEuroParams> = {}) {
    this.minCutoff = params.minCutoff ?? 1.1;
    this.beta = params.beta ?? 1.5;
    this.dCutoff = params.dCutoff ?? 1.0;
  }

  setParams(params: Partial<OneEuroParams>): void {
    if (params.minCutoff !== undefined) this.minCutoff = params.minCutoff;
    if (params.beta !== undefined) this.beta = params.beta;
    if (params.dCutoff !== undefined) this.dCutoff = params.dCutoff;
  }

  reset(value = 0, tsMs?: number): void {
    if (tsMs === undefined) {
      this.initialized = false;
      this.xPrev = value;
      this.dxPrev = 0;
      this.lastTsMs = 0;
    } else {
      this.initialized = true;
      this.xPrev = value;
      this.dxPrev = 0;
      this.lastTsMs = tsMs;
    }
  }

  filter(x: number, tsMs: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(tsMs)) {
      return this.xPrev;
    }
    if (!this.initialized) {
      this.initialized = true;
      this.xPrev = x;
      this.dxPrev = 0;
      this.lastTsMs = tsMs;
      return x;
    }

    const dtMs = tsMs - this.lastTsMs;
    if (dtMs <= 0) {
      return this.xPrev;
    }
    // Clamp huge pauses (e.g. tab backgrounded) to prevent derivative spikes.
    const te = Math.min(dtMs / 1000, 0.25);
    this.lastTsMs = tsMs;

    const dx = (x - this.xPrev) / te;
    const alphaD = smoothingFactor(te, this.dCutoff);
    const dxHat = expSmoothing(alphaD, dx, this.dxPrev);

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const alpha = smoothingFactor(te, cutoff);
    const xHat = expSmoothing(alpha, x, this.xPrev);

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

/**
 * Applies a radial dead zone (in radians) around zero or relative to an anchor,
 * preserving smooth ramp-out outside the dead zone so there's no sudden jump.
 */
export function applyDeadZone(valueRad: number, deadZoneRad: number): number {
  if (deadZoneRad <= 0) return valueRad;
  const mag = Math.abs(valueRad);
  if (mag <= deadZoneRad) return 0;
  return Math.sign(valueRad) * (mag - deadZoneRad);
}
