import { clamp, type GestureKind } from "@gyro/shared";

export interface DetectedGesture {
  kind: GestureKind;
  dx: number;
  dy: number;
  power: number;
  clientTs: number;
}

export class GestureDetector {
  private lastFlickTs = 0;
  private lastSwingTs = 0;

  private flickVelThreshold = 5.0; // rad/s
  private swingAccelThreshold = 13.5; // m/s^2 linear accel

  private activePointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private downTs = 0;
  private swipeAnchorX = 0;
  private swipeAnchorY = 0;
  private swipeAnchorTs = 0;
  private lastLiveSwipeTs = 0;
  private liveSwipeFired = false;
  private holding = false;
  private holdTimer: number | null = null;

  constructor(private readonly onGesture: (gesture: DetectedGesture) => void) {}

  /**
   * Tunes flick/swing thresholds slightly upward on noisy devices based on measured stationary floor.
   */
  calibrateFromNoise(noiseFloorDeg: number): void {
    const extra = clamp(noiseFloorDeg * 0.8, 0, 2.0);
    this.flickVelThreshold = 5.0 + extra;
    this.swingAccelThreshold = 13.5 + extra * 1.5;
  }

  pushMotionSample(
    angVelMag: number,
    linearAccelMag: number,
    ax: number,
    ay: number,
    _az: number,
    tsMs: number,
  ): void {
    // Cricket bat swing: combined strong linear acceleration + rotation
    if (
      linearAccelMag >= this.swingAccelThreshold &&
      angVelMag >= 4.0 &&
      tsMs - this.lastSwingTs > 380
    ) {
      this.lastSwingTs = tsMs;
      this.lastFlickTs = tsMs;
      const norm = Math.hypot(ax, ay) || 1;
      this.onGesture({
        kind: "swing",
        dx: clamp(ax / norm, -1, 1),
        dy: clamp(ay / norm, -1, 1),
        power: clamp(linearAccelMag / 22, 0.25, 2.5),
        clientTs: tsMs,
      });
      return;
    }

    // Wrist flick (e.g. reload / shockwave)
    if (angVelMag >= this.flickVelThreshold && tsMs - this.lastFlickTs > 300) {
      this.lastFlickTs = tsMs;
      this.onGesture({
        kind: "flick",
        dx: 0,
        dy: -1,
        power: clamp(angVelMag / 9, 0.2, 2.0),
        clientTs: tsMs,
      });
    }
  }

  attachPadSurface(
    el: HTMLElement,
    onDragDelta?: (dxNorm: number, dyNorm: number) => void,
  ): () => void {
    const onPointerDown = (e: PointerEvent) => {
      if (this.activePointerId !== null) return;
      this.activePointerId = e.pointerId;
      el.setPointerCapture?.(e.pointerId);
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.swipeAnchorX = e.clientX;
      this.swipeAnchorY = e.clientY;
      this.downTs = performance.now();
      this.swipeAnchorTs = this.downTs;
      this.holding = false;
      this.liveSwipeFired = false;

      this.holdTimer = window.setTimeout(() => {
        if (this.activePointerId === e.pointerId) {
          this.holding = true;
          this.onGesture({
            kind: "hold_start",
            dx: 0,
            dy: 0,
            power: 1,
            clientTs: performance.now(),
          });
        }
      }, 210);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== this.activePointerId) return;
      const now = performance.now();
      const rect = el.getBoundingClientRect();
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (onDragDelta && rect.width > 0 && rect.height > 0) {
        onDragDelta(dx / rect.width, dy / rect.height);
      }

      if (this.holdTimer !== null && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) >= 18) {
        window.clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }

      if (!this.holding) {
        const segDx = e.clientX - this.swipeAnchorX;
        const segDy = e.clientY - this.swipeAnchorY;
        const segDist = Math.hypot(segDx, segDy);
        const segElapsed = Math.max(1, now - this.swipeAnchorTs);
        const segSpeed = segDist / segElapsed;
        if (segDist >= 40 && segSpeed >= 0.55 && now - this.lastLiveSwipeTs >= 95) {
          this.lastLiveSwipeTs = now;
          this.liveSwipeFired = true;
          this.onGesture({
            kind: "swipe",
            dx: clamp(segDx / segDist, -1, 1),
            dy: clamp(segDy / segDist, -1, 1),
            power: clamp(segSpeed / 1.4, 0.35, 2.5),
            clientTs: now,
          });
          this.swipeAnchorX = e.clientX;
          this.swipeAnchorY = e.clientY;
          this.swipeAnchorTs = now;
        } else if (segElapsed > 160 && segSpeed < 0.25) {
          this.swipeAnchorX = e.clientX;
          this.swipeAnchorY = e.clientY;
          this.swipeAnchorTs = now;
        }
      }
    };

    const finishPointer = (e: PointerEvent) => {
      if (e.pointerId !== this.activePointerId) return;
      this.activePointerId = null;
      if (this.holdTimer !== null) {
        window.clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }

      const now = performance.now();
      const elapsed = Math.max(1, now - this.downTs);
      const dx = e.clientX - this.downX;
      const dy = e.clientY - this.downY;
      const dist = Math.hypot(dx, dy);

      if (this.holding) {
        this.holding = false;
        this.onGesture({
          kind: "hold_end",
          dx: 0,
          dy: 0,
          power: clamp(elapsed / 1000, 0.2, 2.0),
          clientTs: now,
        });
        return;
      }

      if (this.liveSwipeFired) {
        const tailDx = e.clientX - this.swipeAnchorX;
        const tailDy = e.clientY - this.swipeAnchorY;
        const tailDist = Math.hypot(tailDx, tailDy);
        const tailElapsed = Math.max(1, now - this.swipeAnchorTs);
        const tailSpeed = tailDist / tailElapsed;
        if (tailDist >= 28 && tailSpeed >= 0.55 && now - this.lastLiveSwipeTs >= 60) {
          this.onGesture({
            kind: "swipe",
            dx: clamp(tailDx / tailDist, -1, 1),
            dy: clamp(tailDy / tailDist, -1, 1),
            power: clamp(tailSpeed / 1.4, 0.3, 2.5),
            clientTs: now,
          });
        }
        return;
      }

      if (dist >= 34 && elapsed <= 280) {
        const speed = dist / elapsed; // px/ms
        this.onGesture({
          kind: "swipe",
          dx: clamp(dx / dist, -1, 1),
          dy: clamp(dy / dist, -1, 1),
          power: clamp(speed / 1.4, 0.25, 2.5),
          clientTs: now,
        });
        return;
      }

      if (dist < 24 && elapsed < 250) {
        this.onGesture({
          kind: "tap",
          dx: 0,
          dy: 0,
          power: 1,
          clientTs: now,
        });
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", finishPointer);
    el.addEventListener("pointercancel", finishPointer);

    return () => {
      if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", finishPointer);
      el.removeEventListener("pointercancel", finishPointer);
    };
  }

  isHolding(): boolean {
    return this.holding || this.activePointerId !== null;
  }
}
