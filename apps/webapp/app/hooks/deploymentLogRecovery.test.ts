import { S2Error } from "@s2-dev/streamstore";
import { expect, it } from "vitest";
import { readDeploymentLogsWithRecovery } from "./deploymentLogRecovery";

it("recovers a delayed stream and a disconnect using the same caller-owned cursor", async () => {
  let calls = 0;
  let cursor = 0;
  const entries: number[] = [];
  const errors: boolean[] = [];
  let complete = false;
  await readDeploymentLogsWithRecovery({
    signal: new AbortController().signal,
    delays: [0, 0],
    canRetry: () => true,
    onError: (retrying) => errors.push(retrying),
    onConnected: () => {
      complete = true;
    },
    read: async () => {
      calls++;
      if (calls === 1) throw new Error("stream_not_found");
      entries.push(cursor++);
      if (calls === 2) throw new Error("disconnected");
    },
  });
  expect(calls).toBe(3);
  expect(entries).toEqual([0, 1]);
  expect(errors).toEqual([true, true]);
  expect(complete).toBe(true);
});

it("stops after the retry budget and treats permission denial as nonretryable", async () => {
  for (const retryable of [true, false]) {
    let calls = 0;
    const errors: boolean[] = [];
    await readDeploymentLogsWithRecovery({
      signal: new AbortController().signal,
      delays: [0, 0],
      canRetry: () => retryable,
      onError: (retrying) => errors.push(retrying),
      onConnected: () => {
        throw new Error("must not succeed");
      },
      read: async () => {
        calls++;
        throw new Error("unavailable");
      },
    });
    expect(calls).toBe(retryable ? 3 : 1);
    expect(errors.at(-1)).toBe(false);
  }
});

it("cancels backoff on navigation without opening another stream", async () => {
  const controller = new AbortController();
  let calls = 0;
  await readDeploymentLogsWithRecovery({
    signal: controller.signal,
    delays: [60_000],
    canRetry: () => true,
    onError: () => queueMicrotask(() => controller.abort()),
    onConnected: () => {},
    read: async () => {
      calls++;
      throw new Error("missing");
    },
  });
  expect(calls).toBe(1);
});

it("does not reconnect after a successful read", async () => {
  let calls = 0;
  await readDeploymentLogsWithRecovery({
    signal: new AbortController().signal,
    canRetry: () => true,
    onError: () => {
      throw new Error("unexpected error");
    },
    onConnected: () => {},
    read: async () => {
      calls++;
    },
  });
  expect(calls).toBe(1);
});

it("retries a missing stream", async () => {
  let calls = 0;
  let completed = false;
  const errors: boolean[] = [];
  await readDeploymentLogsWithRecovery({
    signal: new AbortController().signal,
    delays: [0],
    canRetry: () => true,
    onError: (retrying) => errors.push(retrying),
    onConnected: () => {
      completed = true;
    },
    read: async () => {
      calls++;
      if (calls === 1)
        throw new S2Error({ message: "Missing", code: "stream_not_found", status: 404 });
    },
  });
  expect(calls).toBe(2);
  expect(errors).toEqual([true]);
  expect(completed).toBe(true);
});

it("still retries transient errors for a finished deployment", async () => {
  let calls = 0;
  const errors: boolean[] = [];
  await readDeploymentLogsWithRecovery({
    signal: new AbortController().signal,
    delays: [0],
    canRetry: () => true,
    onError: (retrying) => errors.push(retrying),
    onConnected: () => {},
    read: async () => {
      if (++calls === 1) throw new Error("disconnected");
    },
  });
  expect(calls).toBe(2);
  expect(errors).toEqual([true]);
});
