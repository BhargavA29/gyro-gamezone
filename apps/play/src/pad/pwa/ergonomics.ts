import type { HapticPattern } from "@gyro/shared";

let wakeLockSentinel: WakeLockSentinel | null = null;
let wakeLockListenerBound = false;

export async function acquireWakeLock(): Promise<boolean> {
  if (!("wakeLock" in navigator) || !navigator.wakeLock) return false;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    if (!wakeLockListenerBound) {
      wakeLockListenerBound = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          void acquireWakeLock();
        }
      });
    }
    return true;
  } catch {
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {
      // Ignore already released sentinel
    }
    wakeLockSentinel = null;
  }
}

export async function lockPortraitOrientation(): Promise<boolean> {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (orientation: string) => Promise<void>;
  };
  if (!orientation || typeof orientation.lock !== "function") {
    return false;
  }
  try {
    await orientation.lock("portrait-primary");
    return true;
  } catch {
    // Expected on iOS Safari / desktop browsers when not fullscreen
    return false;
  }
}

const HAPTIC_PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 12,
  hit: [18, 16, 28],
  combo: [14, 14, 14, 14, 36],
  tension: 8,
  error: [40, 30, 40],
};

export function triggerHaptic(pattern: HapticPattern): boolean {
  if (typeof navigator.vibrate !== "function") return false;
  try {
    return navigator.vibrate(HAPTIC_PATTERNS[pattern]);
  } catch {
    return false;
  }
}
