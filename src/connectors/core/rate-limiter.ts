import type { RateLimiter, RateLimiterConfig } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly minDelayMs: number;
  private readonly maxUnits: number;
  private readonly unitsWindowMs: number;

  private requestTimestamps: number[] = [];
  private unitTimestamps: { ts: number; cost: number }[] = [];
  private backoffUntil = 0;
  private lastCallAt = 0;

  // Allow external updates from response headers
  private remainingRequests: number | null = null;
  private remainingUnits: number | null = null;
  private resetAt: number | null = null;

  constructor(config: RateLimiterConfig = {}) {
    this.maxRequests = config.maxRequests ?? Infinity;
    this.windowMs = config.windowMs ?? 60_000;
    this.minDelayMs = config.minDelayMs ?? 0;
    this.maxUnits = config.maxUnitsPerWindow ?? Infinity;
    this.unitsWindowMs = config.unitsWindowMs ?? config.windowMs ?? 60_000;
  }

  async acquire(cost = 1): Promise<void> {
    // Wait for backoff (429 response)
    const now = Date.now();
    if (this.backoffUntil > now) {
      await sleep(this.backoffUntil - now);
    }

    // If we have header-reported remaining counts, respect them
    if (this.remainingRequests !== null && this.remainingRequests < 5) {
      if (this.resetAt && this.resetAt > Date.now()) {
        await sleep(this.resetAt - Date.now() + 100);
      }
    }

    // Enforce min delay between calls
    if (this.minDelayMs > 0) {
      const elapsed = Date.now() - this.lastCallAt;
      if (elapsed < this.minDelayMs) {
        await sleep(this.minDelayMs - elapsed);
      }
    }

    // Enforce request window
    if (this.maxRequests < Infinity) {
      this.requestTimestamps = this.requestTimestamps.filter(
        (ts) => Date.now() - ts < this.windowMs,
      );
      if (this.requestTimestamps.length >= this.maxRequests) {
        const oldest = this.requestTimestamps[0];
        const waitMs = this.windowMs - (Date.now() - oldest) + 50;
        await sleep(waitMs);
        this.requestTimestamps = this.requestTimestamps.filter(
          (ts) => Date.now() - ts < this.windowMs,
        );
      }
      this.requestTimestamps.push(Date.now());
    }

    // Enforce unit budget
    if (this.maxUnits < Infinity && cost > 0) {
      this.unitTimestamps = this.unitTimestamps.filter(
        (u) => Date.now() - u.ts < this.unitsWindowMs,
      );
      const currentUnits = this.unitTimestamps.reduce(
        (sum, u) => sum + u.cost,
        0,
      );
      if (currentUnits + cost > this.maxUnits) {
        const oldest = this.unitTimestamps[0];
        const waitMs = this.unitsWindowMs - (Date.now() - oldest.ts) + 50;
        await sleep(waitMs);
        this.unitTimestamps = this.unitTimestamps.filter(
          (u) => Date.now() - u.ts < this.unitsWindowMs,
        );
      }
      this.unitTimestamps.push({ ts: Date.now(), cost });
    }

    this.lastCallAt = Date.now();
  }

  backoff(retryAfterMs: number): void {
    this.backoffUntil = Date.now() + retryAfterMs;
  }

  updateFromHeaders(headers: Record<string, string>): void {
    // Common header patterns across APIs
    const remaining =
      headers["x-ratelimit-remaining"] ??
      headers["x-ratelimit-requests-remaining"];
    if (remaining !== undefined) {
      this.remainingRequests = parseInt(remaining, 10);
    }

    const reset =
      headers["x-ratelimit-reset"] ?? headers["x-ratelimit-requests-reset"];
    if (reset !== undefined) {
      const resetVal = parseInt(reset, 10);
      // Could be epoch seconds or ms
      this.resetAt = resetVal < 1e12 ? resetVal * 1000 : resetVal;
    }

    const unitsRemaining = headers["x-ratelimit-complexity-remaining"];
    if (unitsRemaining !== undefined) {
      this.remainingUnits = parseInt(unitsRemaining, 10);
    }
  }
}

export function createRateLimiter(config: RateLimiterConfig = {}): RateLimiter {
  return new TokenBucketRateLimiter(config);
}
