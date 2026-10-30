import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock, createMock, transactionMock, outboxCreateMock, updateManyMock } =
  vi.hoisted(() => ({
    findUniqueMock: vi.fn(),
    createMock: vi.fn(),
    transactionMock: vi.fn(),
    outboxCreateMock: vi.fn(),
    updateManyMock: vi.fn(),
  }));

vi.mock("../../src/db/prisma.js", () => ({
  prisma: {
    $transaction: transactionMock,
    job: {
      findUnique: findUniqueMock,
      create: createMock,
      updateMany: updateManyMock,
    },
    outBoxEvent: {
      create: outboxCreateMock,
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
    transactionMock.mockImplementation(async (callback) =>
      callback({
        job: {
          create: createMock,
          findUnique: findUniqueMock,
          updateMany: updateManyMock,
        },
        outBoxEvent: {
          create: outboxCreateMock,
        },
      }),
    );
    createMock.mockResolvedValue({
      id: "job-123",
      type: "email",
      payload: { to: "test@example.com" },
      status: "QUEUED",
      maxAttempts: 3,
    });
    outboxCreateMock.mockResolvedValue({
      id: "outbox-123",
      jobId: "job-123",
      eventType: "JOB_CREATED",
      status: "PENDING",
    });

    const response = await request(app)
      .post("/jobs")
      .send({
        type: "email",
        payload: { to: "test@example.com" },
      });

    expect(response.status).toBe(201);
    expect(response.body.job.id).toBe("job-123");
    expect(createMock).toHaveBeenCalledOnce();
    expect(outboxCreateMock).toHaveBeenCalledOnce();
    expect(transactionMock).toHaveBeenCalledOnce();
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

  it("retries a failed job and creates an outbox event", async () => {
    transactionMock.mockImplementation(async (callback) =>
      callback({
        job: {
          findUnique: findUniqueMock,
          updateMany: updateManyMock,
        },
        outBoxEvent: {
          create: outboxCreateMock,
        },
      }),
    );

    findUniqueMock.mockResolvedValue({
      id: "job-123",
      type: "email",
      payload: { to: "test@example.com" },
      status: "FAILED",
    });

    updateManyMock.mockResolvedValue({ count: 1 });
    outboxCreateMock.mockResolvedValue({ id: "outbox-retry-123" });

    const response = await request(app).post("/jobs/job-123/retry");

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("RETRYING");
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-123", status: "FAILED" },
        data: expect.objectContaining({
          status: "RETRYING",
          attempts: 0,
          lastError: null,
        }),
      }),
    );
    expect(outboxCreateMock).toHaveBeenCalledOnce();
  });

  it("rejects retrying a completed job", async () => {
    transactionMock.mockImplementation(async (callback) =>
      callback({
        job: {
          findUnique: findUniqueMock,
          updateMany: updateManyMock,
        },
        outBoxEvent: {
          create: outboxCreateMock,
        },
      }),
    );

    findUniqueMock.mockResolvedValue({
      id: "job-123",
      status: "COMPLETED",
    });

    const response = await request(app).post("/jobs/job-123/retry");

    expect(response.status).toBe(409);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(outboxCreateMock).not.toHaveBeenCalled();
  });

  it("returns 404 when retrying a nonexistent job", async () => {
    transactionMock.mockImplementation(async (callback) =>
      callback({
        job: {
          findUnique: findUniqueMock,
          updateMany: updateManyMock,
        },
        outBoxEvent: {
          create: outboxCreateMock,
        },
      }),
    );

    findUniqueMock.mockResolvedValue(null);

    const response = await request(app).post("/jobs/missing/retry");

    expect(response.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(outboxCreateMock).not.toHaveBeenCalled();
  });

  it("does not create an outbox event if the failed-job update affects zero rows", async () => {
    transactionMock.mockImplementation(async (callback) =>
      callback({
        job: {
          findUnique: findUniqueMock,
          updateMany: updateManyMock,
        },
        outBoxEvent: {
          create: outboxCreateMock,
        },
      }),
    );

    findUniqueMock.mockResolvedValue({
      id: "job-123",
      status: "FAILED",
      type: "email",
      payload: { to: "test@example.com" },
    });

    updateManyMock.mockResolvedValue({ count: 0 });

    const response = await request(app).post("/jobs/job-123/retry");

    expect(response.status).toBe(409);
    expect(outboxCreateMock).not.toHaveBeenCalled();
  });
});
