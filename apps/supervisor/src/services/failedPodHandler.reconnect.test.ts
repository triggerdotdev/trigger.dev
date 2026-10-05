import { describe, expect, it, vi } from "vitest";
import {
  ListWatch,
  type KubernetesObject,
  type ListPromise,
  type Watch,
} from "@kubernetes/client-node";
import { Registry } from "prom-client";
import type { K8sApi } from "../clients/kubernetes.js";
import { FailedPodHandler } from "./failedPodHandler.js";

describe("FailedPodHandler reconnects", () => {
  type WatchCall = {
    query: Record<string, string>;
    callback: (phase: string, obj: unknown) => void;
    done: (err: unknown) => void;
  };

  /** The client's own ListWatch over a fake Watch, which can fail to connect as the real one does. */
  function setup(connects: Array<"ok" | "fail" | "gone"> = []) {
    const calls: WatchCall[] = [];
    const aborts: number[] = [];
    const watch = {
      watch: vi.fn(
        async (
          _path: string,
          query: Record<string, string>,
          callback: WatchCall["callback"],
          done: WatchCall["done"]
        ) => {
          calls.push({ query, callback, done });
          const index = calls.length - 1;
          // The real Watch calls done with its fetch error before returning.
          const connect = connects.shift();
          if (connect === "fail") {
            done(new Error("connect ECONNREFUSED"));
          }
          if (connect === "gone") {
            done(Object.assign(new Error("Gone"), { statusCode: 410 }));
          }
          return { abort: () => aborts.push(index) };
        }
      ),
    };
    const listNamespacedPod = vi.fn();
    const deleteNamespacedPod = vi.fn(async () => ({}));
    const handler = new FailedPodHandler({
      namespace: "v4-runs",
      reconnectIntervalMs: 1,
      register: new Registry(),
      k8s: {
        makeInformer: (path: string, listFn: ListPromise<KubernetesObject>, selector?: string) =>
          new ListWatch(path, watch as unknown as Watch, listFn, false, selector),
        core: { listNamespacedPod, deleteNamespacedPod },
      } as unknown as K8sApi,
    });
    return { calls, aborts, handler, listNamespacedPod, deleteNamespacedPod };
  }

  function failedPod(name: string, resourceVersion = "2") {
    return {
      metadata: { name, namespace: "v4-runs", uid: `uid-${name}`, resourceVersion },
      status: { phase: "Failed" },
    };
  }

  const emptyList = (resourceVersion: string) => ({ items: [], metadata: { resourceVersion } });

  // The client relists inside the start when the watch it opens answers 410, and
  // nothing awaits that list: its failure must become a reconnect, not a crash.
  it("reconnects when a start's watch is gone and its relist fails", async () => {
    const { calls, handler, listNamespacedPod, deleteNamespacedPod } = setup(["ok", "gone", "ok"]);
    // The reconnect has a resourceVersion, so its only list is the relist the 410 starts.
    listNamespacedPod
      .mockResolvedValueOnce(emptyList("1"))
      .mockRejectedValueOnce(new Error("list 503"))
      .mockResolvedValue(emptyList("3"));
    await handler.start();

    calls[0]!.done(new Error("stream reset"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.callback("ADDED", failedPod("pod-a"));

    await vi.waitFor(() =>
      expect(deleteNamespacedPod).toHaveBeenCalledWith({ name: "pod-a", namespace: "v4-runs" })
    );
    await handler.stop();
  });

  it("closes the watch a start opens after it was stopped", async () => {
    const { calls, aborts, handler, listNamespacedPod } = setup();
    let listed!: (list: unknown) => void;
    listNamespacedPod.mockReturnValueOnce(new Promise((resolve) => (listed = resolve)));
    const started = handler.start();
    await vi.waitFor(() => expect(listNamespacedPod).toHaveBeenCalled());

    await handler.stop();
    listed(emptyList("1"));
    await started;

    expect(calls).toHaveLength(1);
    expect(aborts).toContain(0);
  });

  it("keeps reconnecting while the watch fails to connect", async () => {
    const { calls, handler, listNamespacedPod, deleteNamespacedPod } = setup([
      "ok",
      "fail",
      "fail",
      "ok",
    ]);
    listNamespacedPod.mockResolvedValue(emptyList("1"));
    await handler.start();

    calls[0]!.done(new Error("stream reset"));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3]!.callback("ADDED", failedPod("pod-a"));

    await vi.waitFor(() =>
      expect(deleteNamespacedPod).toHaveBeenCalledWith({ name: "pod-a", namespace: "v4-runs" })
    );
    await handler.stop();
  });

  it("keeps reconnecting while the list fails", async () => {
    const { calls, handler, listNamespacedPod } = setup();
    listNamespacedPod
      .mockResolvedValueOnce(emptyList("1"))
      .mockRejectedValueOnce({ code: 503 })
      .mockRejectedValueOnce({ code: 503 })
      .mockResolvedValue(emptyList("5"));
    await handler.start();

    // A watch error drops the resource version only on a 410, so make the reconnect relist.
    calls[0]!.done({ statusCode: 410 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(listNamespacedPod).toHaveBeenCalledTimes(4);
    expect(calls[1]!.query.resourceVersion).toBe("5");
    await handler.stop();
  });

  it("reconnects after a failed relist without dropping its cached pods", async () => {
    const { calls, handler, listNamespacedPod, deleteNamespacedPod } = setup();
    listNamespacedPod
      .mockResolvedValueOnce({
        items: [failedPod("pod-a", "1")],
        metadata: { resourceVersion: "1" },
      })
      .mockRejectedValueOnce({ code: 503 })
      .mockResolvedValue({ items: [failedPod("pod-a", "1")], metadata: { resourceVersion: "9" } });
    await handler.start();
    await vi.waitFor(() => expect(deleteNamespacedPod).toHaveBeenCalledTimes(1));

    // A 410 in the stream, then the close: the client relists on its own.
    calls[0]!.callback("ERROR", { code: 410 });
    calls[0]!.done(null);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(listNamespacedPod).toHaveBeenCalledTimes(3);
    expect(calls[1]!.query.resourceVersion).toBe("9");
    // Still cached, so the relist is an update and the pod is not processed twice.
    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1);

    calls[1]!.callback("ADDED", failedPod("pod-b", "10"));
    await vi.waitFor(() => expect(deleteNamespacedPod).toHaveBeenCalledTimes(2));
    await handler.stop();
  });

  it("stops reconnecting once stopped", async () => {
    const { calls, handler, listNamespacedPod } = setup(["ok", "fail"]);
    listNamespacedPod.mockResolvedValue(emptyList("1"));
    await handler.start();

    calls[0]!.done(new Error("stream reset"));
    await handler.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toHaveLength(1);
  });
});
