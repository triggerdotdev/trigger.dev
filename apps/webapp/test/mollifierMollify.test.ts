import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { mollifyTrigger } from "~/v3/mollifier/mollifierMollify.server";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";

function fakeBuffer(): { buffer: MollifierBuffer; accept: ReturnType<typeof vi.fn> } {
  const accept = vi.fn(async () => undefined);
  return {
    buffer: { accept } as unknown as MollifierBuffer,
    accept,
  };
}

describe("mollifyTrigger", () => {
  it("writes the snapshot to buffer and returns synthesised result", async () => {
    const { buffer, accept } = fakeBuffer();
    const result = await mollifyTrigger({
      runFriendlyId: "run_friendly_1",
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
      runId: "run_friendly_1",
      envId: "env_a",
      orgId: "org_1",
      payload: expect.any(String),
    });
    expect(result.run.friendlyId).toBe("run_friendly_1");
    expect(result.error).toBeUndefined();
    expect(result.isCached).toBe(false);
    expect(result.notice).toEqual({
      code: "mollifier.queued",
      message: expect.stringContaining("burst buffer"),
      docs: expect.stringContaining("trigger.dev/docs"),
    });
  });

  it("snapshot is round-trippable: payload field is parseable JSON of engineTriggerInput", async () => {
    const { buffer, accept } = fakeBuffer();
    const engineInput = { taskIdentifier: "t", payload: "{}", tags: ["a", "b"] };
    await mollifyTrigger({
      runFriendlyId: "run_x",
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
