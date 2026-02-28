import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../../../src/connectors/core/rate-limiter.js";

describe("TokenBucketRateLimiter", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = new TokenBucketRateLimiter({
      maxRequests: 100,
      windowMs: 1000,
    });
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("respects min delay between calls", async () => {
    const limiter = new TokenBucketRateLimiter({ minDelayMs: 50 });
    await limiter.acquire();
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // allow small margin
  });

  it("backoff pauses subsequent calls", async () => {
    const limiter = new TokenBucketRateLimiter();
    limiter.backoff(100);
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it("updateFromHeaders stores remaining count", () => {
    const limiter = new TokenBucketRateLimiter();
    // Should not throw
    limiter.updateFromHeaders({
      "x-ratelimit-remaining": "100",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
    });
  });
});
