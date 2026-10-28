import { describe, expect, it, vi } from "vitest";
import { checkWithTimeout } from "../../src/api/routes/health-check.js";

describe("checkWithTimeout", () => {
  it("returns true when the check succeeds", async () => {
    await expect(checkWithTimeout(async () => "PONG")).resolves.toBe(true);
  });

  it("returns false when the check throws", async () => {
    await expect(
      checkWithTimeout(async () => {
        throw new Error("Dependency unavailable");
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the check times out", async () => {
    vi.useFakeTimers();

    try {
      const result = checkWithTimeout(() => new Promise<void>(() => {}), 100);

      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
