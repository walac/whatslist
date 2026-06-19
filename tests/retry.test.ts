import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure then returns on success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      initialDelayMs: 1,
      maxRetries: 5,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after all retries are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(fn, { maxRetries: 3, initialDelayMs: 1 })
    ).rejects.toThrow("always fails");

    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("applies exponential backoff timing", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number
    ) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as typeof setTimeout);

    const failFn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      withRetry(failFn, {
        maxRetries: 3,
        initialDelayMs: 100,
        multiplier: 2,
        jitter: 0,
      })
    ).rejects.toThrow();

    expect(delays).toHaveLength(3);
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);

    vi.restoreAllMocks();
  });

  it("stops retrying when shouldRetry returns false", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("fatal: not authorized"))
      .mockResolvedValue("ok");

    await expect(
      withRetry(fn, {
        maxRetries: 5,
        initialDelayMs: 1,
        shouldRetry: (err) => !err.message.includes("fatal"),
      })
    ).rejects.toThrow("fatal: not authorized");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries all attempts when shouldRetry always returns true", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("retriable"));

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 1,
        shouldRetry: () => true,
      })
    ).rejects.toThrow("retriable");

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
