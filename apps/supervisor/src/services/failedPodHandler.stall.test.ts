import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ListWatch,
  type KubernetesObject,
  type ListPromise,
  type Watch,
} from "@kubernetes/client-node";
import { Registry } from "prom-client";
import type { K8sApi } from "../clients/kubernetes.js";
import { FailedPodHandler } from "./failedPodHandler.js";

// The stall check itself is covered in reconnectingInformer.test.ts.
describe("FailedPodHandler watch stalls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type WatchCall = { path: string; aborted: boolean };

  /** The client's own ListWatch over a fake Watch, which stays silent. */
  function setup() {
    const calls: WatchCall[] = [];
    const watch = {
      watch: vi.fn(async (path: string) => {
        const call: WatchCall = { path, aborted: false };
        calls.push(call);
        return { abort: () => (call.aborted = true) };
      }),
    };
    const handler = new FailedPodHandler({
      namespace: "v4-runs",
      reconnectIntervalMs: 1,
      watchTimeoutSeconds: 120,
      register: new Registry(),
      k8s: {
        makeInformer: (path: string, listFn: ListPromise<KubernetesObject>, selector?: string) =>
          new ListWatch(path, watch as unknown as Watch, listFn, false, selector),
        core: {
          listNamespacedPod: vi.fn(async () => ({ items: [], metadata: { resourceVersion: "1" } })),
          deleteNamespacedPod: vi.fn(async () => ({})),
        },
      } as unknown as K8sApi,
    });
    return { calls, handler };
  }

  it("asks the server to close each watch at the configured timeout", async () => {
    const { calls, handler } = setup();
    await handler.start();

    expect(calls[0]!.path).toBe("/api/v1/namespaces/v4-runs/pods?timeoutSeconds=120");
    await handler.stop();
  });

  it("reconnects a silent watch and counts the stall", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { calls, handler } = setup();
    await handler.start();

    // Past 120 s plus the 30 s grace, at the next 30 s check.
    await vi.advanceTimersByTimeAsync(180_000);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.aborted).toBe(true);

    const events = await handler.getMetrics().informerEventsTotal.get();
    expect(events.values).toContainEqual(
      expect.objectContaining({ labels: { namespace: "v4-runs", verb: "stalled" }, value: 1 })
    );
    await handler.stop();
  });
});
