import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock, createMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock("../../src/db/prisma.js", () => ({
  prisma: {
    job: {
      findUnique: findUniqueMock,
      create: createMock,
    },
  },
}));

// Mock the jobQueue module
vi.mock("../../src/queue/job-queue.js", () => ({
  jobQueue: {
    add: vi.fn().mockResolvedValue({ id: "job-123" }),
  },
}));

import request from "supertest";
import app from "../../src/api/app.js";

describe("Jobs API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a job and returns 201", async () => {
    createMock.mockResolvedValue({
      id: "job-123",
      type: "email",
      payload: { to: "test@example.com" },
      status: "QUEUED",
    });

    const response = await request(app)
      .post("/jobs")
      .send({
        type: "email",
        payload: { to: "test@example.com" },
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("job-123");
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid job input", async () => {
    const response = await request(app).post("/jobs").send({ type: "", payload: {} });

    expect(response.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns a job by ID", async () => {
    findUniqueMock.mockResolvedValue({
      id: "job-123",
      type: "email",
      payload: { to: "test@example.com" },
      status: "QUEUED",
    });

    const response = await request(app).get("/jobs/job-123");

    expect(response.status).toBe(200);
    expect(response.body.id).toBe("job-123");
  });

  it("returns 404 when a job does not exist", async () => {
    findUniqueMock.mockResolvedValue(null);

    const response = await request(app).get("/jobs/missing");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Job not found");
  });
});
