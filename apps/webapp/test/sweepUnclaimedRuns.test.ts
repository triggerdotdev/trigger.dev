import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

const returnUnclaimedMessagesToQueue = vi.fn();

vi.mock("~/v3/runEngine.server", () => ({
  engine: { returnUnclaimedMessagesToQueue },
}));

const environment = { id: "env_1234" } as AuthenticatedEnvironment;

describe("sweepUnclaimedRuns", () => {
  it("swallows a failing sweep so a pause that is already in force is not reported as failed", async () => {
    const { sweepUnclaimedRuns } = await import("~/v3/runQueue.server");

    returnUnclaimedMessagesToQueue.mockRejectedValueOnce(new Error("run queue unavailable"));

    await expect(sweepUnclaimedRuns(environment)).resolves.toBeUndefined();
    expect(returnUnclaimedMessagesToQueue).toHaveBeenCalledWith({ environment, queue: undefined });
  });

  it("passes the queue through when one is targeted", async () => {
    const { sweepUnclaimedRuns } = await import("~/v3/runQueue.server");

    returnUnclaimedMessagesToQueue.mockResolvedValueOnce({
      returned: 2,
      skipped: 0,
      errors: 0,
      passes: 1,
    });

    await sweepUnclaimedRuns(environment, "task/my-task");

    expect(returnUnclaimedMessagesToQueue).toHaveBeenCalledWith({
      environment,
      queue: "task/my-task",
    });
  });
});
