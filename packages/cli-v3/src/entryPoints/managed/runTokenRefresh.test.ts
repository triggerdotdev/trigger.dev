import type { RunTokenInstallResult } from "@trigger.dev/core/v3/workers";
import { describe, expect, it } from "vitest";
import { RunTokenRefresher, type RunTokenUpdate } from "./runTokenRefresh.js";

const NOW_SECONDS = 1_800_000_000;
const MINUTE = 60;

function token(claims: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "run+jwt" })}.${encode(claims)}.signature`;
}

function runToken(expiresInSeconds: number, overrides: Record<string, unknown> = {}) {
  return token({ run_id: "run_a", attempt: 2, exp: NOW_SECONDS + expiresInSeconds, ...overrides });
}

function refresher(initialToken: string | undefined, results: RunTokenInstallResult[] = []) {
  const installed: RunTokenUpdate[] = [];
  const instance = new RunTokenRefresher({
    runId: "run_a",
    attemptNumber: 2,
    initialToken,
    install: async (update) => {
      installed.push(update);
      return results.shift() ?? { result: "success" };
    },
    now: () => NOW_SECONDS * 1_000,
  });
  return { instance, installed };
}

describe("RunTokenRefresher", () => {
  it("reports nothing for attempts started without a run token", () => {
    const { instance } = refresher(undefined);

    expect(instance.report("heartbeat")).toBeUndefined();
    expect(instance.isDue).toBe(false);
  });

  it("installs a replacement, then reports its expiry and the success exactly once", async () => {
    const { instance, installed } = refresher(runToken(10 * MINUTE));
    const replacement = runToken(60 * MINUTE);
    expect(instance.isDue).toBe(true);

    const first = instance.report("heartbeat");
    expect(first).toEqual({ expiresAt: NOW_SECONDS + 10 * MINUTE, trigger: "heartbeat" });
    await expect(instance.handleHeartbeatResponse(first, replacement)).resolves.toEqual({
      result: "success",
    });
    expect(installed).toEqual([{ runId: "run_a", attemptNumber: 2, token: replacement }]);
    expect(instance.isDue).toBe(false);

    const second = instance.report("heartbeat");
    expect(second).toEqual({
      expiresAt: NOW_SECONDS + 60 * MINUTE,
      trigger: "heartbeat",
      installation: { result: "success", trigger: "heartbeat" },
    });
    await instance.handleHeartbeatResponse(second, undefined);
    expect(instance.report("heartbeat")?.installation).toBeUndefined();
  });

  it("keeps the old expiry after a failed install so the next heartbeat asks again", async () => {
    const { instance, installed } = refresher(runToken(10 * MINUTE), [
      { result: "failure", reason: "ack_timeout" },
    ]);

    const first = instance.report("restore");
    await instance.handleHeartbeatResponse(first, runToken(60 * MINUTE));

    const retry = instance.report("heartbeat");
    expect(retry).toEqual({
      expiresAt: NOW_SECONDS + 10 * MINUTE,
      trigger: "heartbeat",
      installation: { result: "failure", reason: "ack_timeout", trigger: "restore" },
    });
    expect(instance.isDue).toBe(true);

    await instance.handleHeartbeatResponse(retry, runToken(60 * MINUTE));
    expect(installed).toHaveLength(2);
    expect(instance.isDue).toBe(false);
  });

  it("keeps an unsent install outcome when the heartbeat carrying it fails", async () => {
    const { instance } = refresher(runToken(10 * MINUTE), [
      { result: "failure", reason: "ipc_error" },
    ]);
    await instance.handleHeartbeatResponse(instance.report("heartbeat"), runToken(60 * MINUTE));

    // The heartbeat carrying this report failed, so handleHeartbeatResponse is never called for it.
    instance.report("heartbeat");

    expect(instance.report("heartbeat")?.installation).toEqual({
      result: "failure",
      reason: "ipc_error",
      trigger: "heartbeat",
    });
  });

  it("ignores overlapping replacements until the child acknowledges the active install", async () => {
    const installed: RunTokenUpdate[] = [];
    let acknowledge!: (result: RunTokenInstallResult) => void;
    const ack = new Promise<RunTokenInstallResult>((resolve) => {
      acknowledge = resolve;
    });
    const instance = new RunTokenRefresher({
      runId: "run_a",
      attemptNumber: 2,
      initialToken: runToken(10 * MINUTE),
      install: (update) => {
        installed.push(update);
        return ack;
      },
      now: () => NOW_SECONDS * 1_000,
    });
    const heartbeat = instance.report("heartbeat");
    const restore = instance.report("restore");
    const installation = instance.handleHeartbeatResponse(heartbeat, runToken(60 * MINUTE));

    await expect(
      instance.handleHeartbeatResponse(restore, runToken(61 * MINUTE))
    ).resolves.toBeUndefined();
    expect(installed).toHaveLength(1);
    expect(instance.report("heartbeat")).toBeUndefined();
    expect(instance.isDue).toBe(true);

    acknowledge({ result: "success" });
    await installation;
    expect(instance.report("heartbeat")).toMatchObject({
      expiresAt: NOW_SECONDS + 60 * MINUTE,
      installation: { result: "success", trigger: "heartbeat" },
    });
  });

  it("never installs a replacement minted for another run or attempt", async () => {
    const { instance, installed } = refresher(runToken(10 * MINUTE));

    for (const replacement of [
      runToken(60 * MINUTE, { attempt: 1 }),
      runToken(60 * MINUTE, { run_id: "run_b" }),
      "not-a-jwt",
    ]) {
      await expect(
        instance.handleHeartbeatResponse(instance.report("heartbeat"), replacement)
      ).resolves.toEqual({ result: "failure", reason: "invalid_token" });
    }

    expect(installed).toEqual([]);
    expect(instance.isDue).toBe(true);
  });
});
