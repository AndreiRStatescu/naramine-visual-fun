import { describe, expect, it, vi } from "vitest";

import { claimNextJob, recoverStaleJobs } from "./worker";

describe("worker queue", () => {
  it("claims with a conditional state transition", async () => {
    const candidate = { id: "job-1", state: "QUEUED" };
    const findFirst = vi.fn().mockResolvedValue(candidate);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi
      .fn()
      .mockResolvedValue({ ...candidate, state: "RUNNING" });
    const database = {
      job: { findFirst, updateMany, findUnique },
    };

    const claimed = await claimNextJob(database as never);

    expect(claimed).toMatchObject({ id: "job-1", state: "RUNNING" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", state: "QUEUED" },
        data: expect.objectContaining({ state: "RUNNING" }),
      }),
    );
  });

  it("does not return a job after losing the claim race", async () => {
    const database = {
      job: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: "job-1", state: "QUEUED" })
          .mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
    };

    await expect(claimNextJob(database as never)).resolves.toBeUndefined();
    expect(database.job.findUnique).not.toHaveBeenCalled();
  });

  it("recovers only stale jobs whose lock still matches", async () => {
    const jobUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const eventCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      job: { updateMany: jobUpdateMany },
      jobEvent: { create: eventCreate },
    };
    const database = {
      job: { findMany: vi.fn().mockResolvedValue([{ id: "stale-job" }]) },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };

    await expect(recoverStaleJobs(database as never, 60_000)).resolves.toBe(1);
    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "stale-job",
          state: "RUNNING",
        }),
        data: expect.objectContaining({ state: "QUEUED", lockedAt: null }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledOnce();
  });
});
