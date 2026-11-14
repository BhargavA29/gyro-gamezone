/**
 * Fixed-window / token-bucket rate limiter for per-client message streams.
 * Prevents flooding or malformed spam from saturating the room loop.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly maxPerSecond: number,
    private readonly burst: number = maxPerSecond,
  ) {
    this.tokens = burst;
    this.lastRefillMs = Date.now();
  }

  allow(nowMs = Date.now()): boolean {
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.maxPerSecond);
      this.lastRefillMs = nowMs;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
