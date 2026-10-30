import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "../../src/worker/graceful-shutdown.js";

describe("createGracefulShutdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the worker before disconnecting the database", async () => {
    const events: string[] = [];

    const shutdown = createGracefulShutdown(
      {
        stopProcessing: async () => {
          events.push("worker-closed");
        },
        disconnectDatabase: async () => {
          events.push("database-disconnected");
        },
      },
      { log: vi.fn(), error: vi.fn() },
    );

    await shutdown("SIGTERM");

    expect(events).toEqual(["worker-closed", "database-disconnected"]);
  });

  it("does not disconnect the database if worker closure fails", async () => {
    const disconnectDatabase = vi.fn().mockResolvedValue(undefined);
    const errorLog = vi.fn();

    const shutdown = createGracefulShutdown(
      {
        stopProcessing: vi.fn().mockRejectedValue(new Error("Worker close failed")),
        disconnectDatabase,
      },
      { log: vi.fn(), error: errorLog },
    );

    await shutdown("SIGTERM");

    expect(disconnectDatabase).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    expect(
      (globalThis as typeof globalThis & { process: { exitCode: number } }).process.exitCode,
    ).toBe(1);
  });

  it("does not run shutdown twice", async () => {
    let releaseWorker!: () => void;

    const stopProcessing = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWorker = resolve;
        }),
    );

    const disconnectDatabase = vi.fn().mockResolvedValue(undefined);

    const shutdown = createGracefulShutdown(
      {
        stopProcessing,
        disconnectDatabase,
      },
      { log: vi.fn(), error: vi.fn() },
    );

    const firstShutdown = shutdown("SIGINT");
    await Promise.resolve();

    await shutdown("SIGTERM");

    expect(stopProcessing).toHaveBeenCalledTimes(1);
    expect(disconnectDatabase).not.toHaveBeenCalled();

    releaseWorker();
    await firstShutdown;

    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
  });
});
