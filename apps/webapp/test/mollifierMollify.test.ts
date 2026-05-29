import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { mollifyTrigger } from "~/v3/mollifier/mollifierMollify.server";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";

function fakeBuffer(
  acceptResult: Awaited<ReturnType<MollifierBuffer["accept"]>> = { kind: "accepted" },
): { buffer: MollifierBuffer; accept: ReturnType<typeof vi.fn> } {
  const accept = vi.fn(async () => acceptResult);
  return {
    buffer: { accept } as unknown as MollifierBuffer,
    accept,
  };
}

describe("mollifyTrigger", () => {
  it("writes the snapshot to buffer and returns synthesised result", async () => {
    const { buffer, accept } = fakeBuffer();
    const result = await mollifyTrigger({
      runFriendlyId: "run_abc123def456",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: { taskIdentifier: "my-task", payload: '{"x":1}' },
      decision: {
        divert: true,
        reason: "per_env_rate",
        count: 150,
        threshold: 100,
      },
      buffer,
    });

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith({
      runId: "run_abc123def456",
      envId: "env_a",
      orgId: "org_1",
      payload: expect.any(String),
      idempotencyKey: undefined,
      taskIdentifier: undefined,
    });
    expect(result.run.friendlyId).toBe("run_abc123def456");
    expect(result.error).toBeUndefined();
    expect(result.isCached).toBe(false);
    expect(result.notice).toEqual({
      code: "mollifier.queued",
      message: expect.stringContaining("burst buffer"),
      docs: expect.stringContaining("trigger.dev/docs"),
    });
  });

  it("echoes the winner's runId with isCached=true on duplicate_idempotency", async () => {
    const { buffer } = fakeBuffer({
      kind: "duplicate_idempotency",
      existingRunId: "run_winner12345",
    });
    const result = await mollifyTrigger({
      runFriendlyId: "run_loser56789a",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: { taskIdentifier: "t", payload: "{}" },
      decision: { divert: true, reason: "per_env_rate", count: 1, threshold: 1 },
      buffer,
      idempotencyKey: "key",
      taskIdentifier: "t",
    });
    expect(result.run.friendlyId).toBe("run_winner12345");
    expect(result.isCached).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  // Regression: the synthetic result MUST carry a populated `run.id`
  // derived from the friendlyId. Without it, the route handler's
  // `saveRequestIdempotency(â€¦, result.run.id)` stores `undefined` as
  // the cached entity id, and on SDK retry Prisma's
  // `findFirst({ where: { id: undefined } })` silently drops the
  // predicate and returns an arbitrary TaskRun â€” a cross-tenant leak
  // path. (See Devin review on PR #3753.)
  it("populates run.id from friendlyId on the happy-accept path", async () => {
    const { buffer } = fakeBuffer();
    const result = await mollifyTrigger({
      runFriendlyId: "run_pri456789ab",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: { taskIdentifier: "t", payload: "{}" },
      decision: { divert: true, reason: "per_env_rate", count: 1, threshold: 1 },
      buffer,
    });
    expect(result.run.id).toBe(RunId.fromFriendlyId("run_pri456789ab"));
    expect(result.run.id).toMatch(/^[a-z0-9]+$/); // non-undefined, non-empty
  });

  it("populates run.id from the WINNER's friendlyId on duplicate_idempotency", async () => {
    const { buffer } = fakeBuffer({
      kind: "duplicate_idempotency",
      existingRunId: "run_winnerdup12",
    });
    const result = await mollifyTrigger({
      runFriendlyId: "run_loser56789a",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: { taskIdentifier: "t", payload: "{}" },
      decision: { divert: true, reason: "per_env_rate", count: 1, threshold: 1 },
      buffer,
      idempotencyKey: "key",
      taskIdentifier: "t",
    });
    expect(result.run.id).toBe(RunId.fromFriendlyId("run_winnerdup12"));
    expect(result.run.id).not.toBe(RunId.fromFriendlyId("run_loser56789a"));
  });

  it("snapshot is round-trippable: payload field is parseable JSON of engineTriggerInput", async () => {
    const { buffer, accept } = fakeBuffer();
    const engineInput = { taskIdentifier: "t", payload: "{}", tags: ["a", "b"] };
    await mollifyTrigger({
      runFriendlyId: "run_xabcde12345",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: engineInput,
      decision: { divert: true, reason: "per_env_rate", count: 1, threshold: 1 },
      buffer,
    });

    const callArg = accept.mock.calls[0][0] as { payload: string };
    expect(JSON.parse(callArg.payload)).toEqual(engineInput);
  });
});
