import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../../src/api/app.js";
import { prisma } from "../../src/db/prisma.js";
import { jobQueue } from "../../src/queue/job-queue.js";

describe("Health endpoints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockRedisReady(result: true | Error) {
    if (result instanceof Error) {
      vi.spyOn(jobQueue, "waitUntilReady").mockRejectedValue(result);
    } else {
      vi.spyOn(jobQueue, "waitUntilReady").mockResolvedValue();
    }
  }

  it("returns 200 for liveness", async () => {
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      service: "Distributed Job Processor",
    });
  });

  it("returns 200 when PostgreSQL and Redis are ready", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([] as never);
    mockRedisReady(true);

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "Distributed Job Processor",
      checks: {
        postgres: true,
        redis: true,
      },
    });
  });

  it("returns 503 when PostgreSQL is unavailable", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("PostgreSQL unavailable"));
    mockRedisReady(true);

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "not_ready",
      service: "Distributed Job Processor",
      checks: {
        postgres: false,
        redis: true,
      },
    });
  });

  it("returns 503 when Redis is unavailable", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([] as never);
    mockRedisReady(new Error("Redis unavailable"));

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "not_ready",
      service: "Distributed Job Processor",
      checks: {
        postgres: true,
        redis: false,
      },
    });
  });

  it("returns 503 when both dependencies are unavailable", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("PostgreSQL unavailable"));
    mockRedisReady(new Error("Redis unavailable"));

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "not_ready",
      service: "Distributed Job Processor",
      checks: {
        postgres: false,
        redis: false,
      },
    });
  });
});
