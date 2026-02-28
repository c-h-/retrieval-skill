import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../../../src/connectors/core/retry.js";

describe("withRetry", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("bad input"));
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }),
    ).rejects.toThrow("bad input");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom retryOn", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 503, message: "unavailable" })
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {
      baseDelayMs: 10,
      retryOn: (err: unknown) => (err as { status?: number }).status === 503,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
