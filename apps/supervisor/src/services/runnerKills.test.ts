import {
  ListWatch,
  type KubernetesObject,
  type ListPromise,
  type V1Pod,
  type Watch,
} from "@kubernetes/client-node";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Registry } from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { K8sApi } from "../clients/kubernetes.js";
import {
  RESTORE_LABEL,
  RunnerKillInformer,
  runnerKill,
  SUSPEND_ANNOTATION,
  type RunnerStartFailure,
} from "../workloadManager/runCrd.js";
import { FailedPodHandler } from "./failedPodHandler.js";
import { podKill, RunnerKillReporter, type RunnerKill } from "./runnerKills.js";

const KILLED_AT = "2026-10-16T12:00:00.000Z";

function failedPod(
  name: string,
  terminated: { exitCode: number; reason?: string; message?: string; finishedAt?: Date },
  runFriendlyId?: string
): V1Pod {
  return {
    metadata: { name, namespace: "runs", uid: `${name}-uid` },
    spec: {
      containers: [
        {
          name: "run-controller",
          env: runFriendlyId
            ? [
                { name: "TRIGGER_RUN_ID", value: runFriendlyId },
                { name: "TRIGGER_ENV_ID", value: "env_a" },
              ]
            : [],
        },
      ],
    },
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          name: "run-controller",
          image: "task:1",
          imageID: "",
          ready: false,
          restartCount: 0,
          state: { terminated: { finishedAt: new Date(KILLED_AT), ...terminated } },
        },
      ],
    },
  };
}

function failedRunner(name: string, reason: string, message: string, runFriendlyId?: string) {
  return {
    apiVersion: "compute.trigger.dev/v1alpha1",
    kind: "Runner",
    metadata: { name, namespace: "runs", uid: `${name}-uid`, resourceVersion: "1" },
    spec: runFriendlyId
      ? { bootstrap: { runFriendlyID: runFriendlyId }, owner: { envID: "env_a" } }
      : {},
    status: {
      phase: "Failed",
      conditions: [
        { type: "Failed", status: "True", reason, message, lastTransitionTime: KILLED_AT },
      ],
    },
  };
}

type WatchCallback = (phase: string, obj: KubernetesObject) => void;

/**
 * A K8sApi whose list returns `items`, whose watch hands its callback to the test, and which
 * records every call and pod deletion in `events`.
 */
function fakeK8s(items: KubernetesObject[], events: string[] = []) {
  const watchCallbacks: WatchCallback[] = [];
  const listCalls: unknown[] = [];
  const watch = {
    watch: async (_path: string, _query: unknown, callback: WatchCallback) => {
      watchCallbacks.push(callback);
      return { abort: () => {} };
    },
  };
  const list = async (args: unknown) => {
    listCalls.push(args);
    return { items, metadata: { resourceVersion: "1" } };
  };
  const k8s = {
    makeInformer: (path: string, listFn: ListPromise<KubernetesObject>, selector?: string) =>
      new ListWatch(path, watch as unknown as Watch, listFn, false, selector),
    core: {
      listNamespacedPod: list,
      deleteNamespacedPod: async ({ name }: { name: string }) => {
        events.push(`delete:${name}`);
        return {};
      },
    },
    custom: {
      listNamespacedCustomObject: list,
    },
  };
  return { k8s: k8s as unknown as K8sApi, events, listCalls, watchCallbacks };
}

type Snapshot = {
  friendlyId: string;
  executionStatus: string;
  createdAt: string;
  attemptNumber?: number;
};

/**
 * A worker API whose latest snapshot is `snapshot` and whose attempt completion answers with
 * the next of `completeStatuses`, then 200. Every request is recorded.
 */
async function workerApi(snapshot: Snapshot | undefined, completeStatuses: number[] = []) {
  const requests: {
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body?: unknown;
  }[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET") {
      if (!snapshot) {
        return send(404, { error: "Run not found" });
      }
      return send(200, {
        execution: {
          version: "1",
          snapshot: {
            id: "s",
            description: "",
            friendlyId: snapshot.friendlyId,
            executionStatus: snapshot.executionStatus,
            createdAt: snapshot.createdAt,
          },
          run: {
            id: "r",
            friendlyId: "run_a",
            status: "EXECUTING",
            attemptNumber: snapshot.attemptNumber ?? 1,
          },
          completedWaitpoints: [],
        },
      });
    }
    const status = completeStatuses.shift() ?? 200;
    if (status !== 200) {
      return send(status, { error: "nope" });
    }
    send(200, {
      result: {
        attemptStatus: "RETRY_QUEUED",
        snapshot: {
          id: "s2",
          friendlyId: "snapshot_2",
          executionStatus: "QUEUED",
          description: "",
          createdAt: new Date().toISOString(),
        },
        run: { id: "r", friendlyId: "run_a", status: "RETRYING_AFTER_FAILURE", attemptNumber: 1 },
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = new SupervisorHttpClient({
    apiUrl: `http://127.0.0.1:${port}`,
    workerToken: "tr_wgt_test",
    instanceName: "test",
  });
  return {
    requests,
    reporter: new RunnerKillReporter({ client: () => client, register: new Registry() }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("podKill", () => {
  it("reads an OOMKilled run-controller as out of memory, with the pod's run", () => {
    expect(podKill(failedPod("r1", { exitCode: 137, reason: "OOMKilled" }, "run_a"))).toEqual({
      code: "TASK_PROCESS_OOM_KILLED",
      runFriendlyId: "run_a",
      environmentId: "env_a",
      killedAt: new Date(KILLED_AT),
    });
  });

  it("reads any other exit 137 as a kill that is not out of memory", () => {
    expect(
      podKill(
        failedPod("r1", { exitCode: 137, reason: "Error", message: "node shutdown" }, "run_a")
      )
    ).toMatchObject({ code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" });
  });

  it("ignores an exit that was not a kill, or a pod without its run", () => {
    expect(podKill(failedPod("r1", { exitCode: 1, reason: "Error" }, "run_a"))).toBeUndefined();
    expect(podKill(failedPod("r1", { exitCode: 137, reason: "OOMKilled" }))).toBeUndefined();
    expect(podKill({ metadata: { name: "r1" }, status: { phase: "Failed" } })).toBeUndefined();
  });
});

describe("runnerKill", () => {
  it("reads an OOMKilled Runner, the microvm guest's OOM included, with its bootstrap run", () => {
    expect(
      runnerKill(
        failedRunner("r1", "OOMKilled", "container run-controller exited with code 137", "run_a")
      )
    ).toEqual({
      code: "TASK_PROCESS_OOM_KILLED",
      runFriendlyId: "run_a",
      environmentId: "env_a",
      killedAt: new Date(KILLED_AT),
      killedAtObserved: true,
    });
  });

  it("reads any other exit 137 as a kill that is not out of memory", () => {
    expect(
      runnerKill(
        failedRunner("r1", "Error", "container run-controller exited with code 137", "run_a")
      )
    ).toMatchObject({ code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" });
  });

  it("ignores a Runner that failed without a kill, has not failed, or has no run", () => {
    expect(
      runnerKill(
        failedRunner(
          "r1",
          "ContainerFailed",
          "container run-controller exited with code 1",
          "run_a"
        )
      )
    ).toBeUndefined();
    expect(
      runnerKill(failedRunner("r1", "Evicted", "low on ephemeral storage", "run_a"))
    ).toBeUndefined();
    expect(
      runnerKill(failedRunner("r1", "OOMKilled", "container run-controller exited with code 137"))
    ).toBeUndefined();
    expect(runnerKill({ status: { phase: "Running" } })).toBeUndefined();
  });

  it("ignores a Runner that was asked to suspend, whose checkpoint may run on elsewhere", () => {
    const killed = failedRunner(
      "r1",
      "Error",
      "container run-controller exited with code 137",
      "run_a"
    );
    expect(
      runnerKill({
        ...killed,
        metadata: { ...killed.metadata, annotations: { [SUSPEND_ANNOTATION]: "snapshot_1" } },
      })
    ).toBeUndefined();
    expect(
      runnerKill({ ...killed, status: { ...killed.status, suspend: { snapshotID: "s1" } } })
    ).toBeUndefined();
  });
});

describe("RunnerKillReporter", () => {
  let api: Awaited<ReturnType<typeof workerApi>> | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  const kill: RunnerKill = {
    code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE",
    runFriendlyId: "run_a",
    environmentId: "env_a",
    killedAt: new Date(KILLED_AT),
  };
  const executing: Snapshot = {
    friendlyId: "snapshot_1",
    executionStatus: "EXECUTING",
    createdAt: "2026-10-16T11:59:00.000Z",
  };

  it("fails the executing attempt with the kill's code and fixed text", async () => {
    api = await workerApi(executing);

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("applied");
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /engine/v1/worker-actions/runs/run_a/snapshots/latest",
      "POST /engine/v1/worker-actions/runs/run_a/snapshots/snapshot_1/attempts/complete",
    ]);
    const complete = api.requests[1]!;
    expect(complete.headers["x-trigger-worker-runner-id"]).toBe("runner-a");
    expect(complete.headers["x-trigger-worker-environment-id"]).toBe("env_a");
    expect(complete.body).toEqual({
      completion: {
        ok: false,
        id: "run_a",
        error: {
          type: "INTERNAL_ERROR",
          code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE",
          message:
            "Your run's process was stopped by a kill signal before it finished. It did not run out of memory, and it will be retried based on your task's retry settings and the number of retries remaining.",
        },
      },
      forceRequeue: true,
    });
  });

  it("fails an attempt that was waiting on a waitpoint", async () => {
    api = await workerApi({ ...executing, executionStatus: "EXECUTING_WITH_WAITPOINTS" });

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("applied");
  });

  it("leaves a run that is no longer executing", async () => {
    api = await workerApi({ ...executing, executionStatus: "FINISHED" });

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("not_executing");
    expect(api.requests).toHaveLength(1);
  });

  it("leaves a run that moved on after the kill", async () => {
    api = await workerApi({ ...executing, createdAt: "2026-10-16T12:00:01.000Z" });

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("not_executing");
    expect(api.requests).toHaveLength(1);
  });

  it("leaves a run that moved on to a later attempt, whatever the timestamps say", async () => {
    api = await workerApi({ ...executing, attemptNumber: 2 });

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("not_executing");
    expect(api.requests).toHaveLength(1);
  });

  it("fails a later attempt's run when the killed runner was created for that attempt", async () => {
    api = await workerApi({ ...executing, attemptNumber: 3 });

    expect(await api.reporter.onRunnerKilled("runner-a-attempt-3", kill)).toBe("applied");
  });

  it("trusts an observed kill time only when the runner names its attempt", async () => {
    const observed = { ...kill, killedAtObserved: true };
    api = await workerApi(executing);

    expect(await api.reporter.onRunnerKilled("runner-a", observed)).toBe("applied");
    // A restore runner's id carries a checkpoint, not an attempt.
    expect(await api.reporter.onRunnerKilled("runner-a-ckpt1234", observed)).toBe("not_executing");
  });

  it("tolerates a completion the platform rejects", async () => {
    api = await workerApi(executing, [400]);

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("error");
  });

  it("tolerates a run the platform cannot find", async () => {
    api = await workerApi(undefined);

    expect(await api.reporter.onRunnerKilled("runner-a", kill)).toBe("error");
  });
});

describe("FailedPodHandler kill reports", () => {
  it("reports the pod's kill by runner id before it deletes the pod", async () => {
    const { k8s, events } = fakeK8s([
      failedPod("runner-oom", { exitCode: 137, reason: "OOMKilled" }, "run_a") as KubernetesObject,
      failedPod("runner-crash", { exitCode: 1, reason: "Error" }, "run_b") as KubernetesObject,
    ]);
    const handler = new FailedPodHandler({
      namespace: "runs",
      register: new Registry(),
      k8s,
      onRunnerKilled: async (runnerId, kill) => {
        events.push(`report:${runnerId}:${kill.code}:${kill.runFriendlyId}`);
      },
    });

    await handler.start();
    await vi.waitFor(() => expect(events.filter((e) => e.startsWith("delete:"))).toHaveLength(2));
    await handler.stop();

    expect(events.filter((e) => e.includes("runner-oom"))).toEqual([
      "report:runner-oom:TASK_PROCESS_OOM_KILLED:run_a",
      "delete:runner-oom",
    ]);
    expect(events.some((e) => e.startsWith("report:runner-crash"))).toBe(false);
  });

  it("does not report a pod that exited with the graceful shutdown code", async () => {
    const { k8s, events } = fakeK8s([
      failedPod("runner-graceful", {
        exitCode: FailedPodHandler.GRACEFUL_SHUTDOWN_EXIT_CODE,
        reason: "Error",
      }) as KubernetesObject,
    ]);
    const handler = new FailedPodHandler({
      namespace: "runs",
      register: new Registry(),
      k8s,
      onRunnerKilled: async (runnerId) => {
        events.push(`report:${runnerId}`);
      },
    });

    await handler.start();
    await vi.waitFor(() => expect(events).toContain("delete:runner-graceful"));
    await handler.stop();

    expect(events).toEqual(["delete:runner-graceful"]);
  });

  it("still deletes the pod when the report fails", async () => {
    const { k8s, events } = fakeK8s([
      failedPod("runner-killed", { exitCode: 137, reason: "Error" }, "run_a") as KubernetesObject,
    ]);
    const handler = new FailedPodHandler({
      namespace: "runs",
      register: new Registry(),
      k8s,
      onRunnerKilled: async () => {
        throw new Error("boom");
      },
    });

    await handler.start();
    await vi.waitFor(() => expect(events).toEqual(["delete:runner-killed"]));
    await handler.stop();
  });
});

describe("RunnerKillInformer", () => {
  it("passes on each Runner the runtime killed once, by name", async () => {
    const oom = failedRunner(
      "runner-oom",
      "OOMKilled",
      "container run-controller exited with code 137",
      "run_a"
    );
    const { k8s, listCalls, watchCallbacks } = fakeK8s([
      oom,
      failedRunner(
        "runner-kill",
        "Error",
        "container run-controller exited with code 137",
        "run_b"
      ),
      failedRunner(
        "runner-crash",
        "ContainerFailed",
        "container run-controller exited with code 1"
      ),
      { ...failedRunner("runner-live", "", ""), status: { phase: "Running" } } as KubernetesObject,
    ]);
    const killed: [string, RunnerKill][] = [];
    const informer = new RunnerKillInformer({
      namespace: "runs",
      k8s,
      onRunnerKilled: (runnerId, kill) => killed.push([runnerId, kill]),
    });

    await informer.start();
    await vi.waitFor(() => expect(killed).toHaveLength(2));
    await vi.waitFor(() => expect(watchCallbacks).toHaveLength(1));

    // The same failed Runner seen again, as an update would show it.
    watchCallbacks[0]!("MODIFIED", { ...oom, metadata: { ...oom.metadata, resourceVersion: "2" } });
    await informer.stop();

    expect(listCalls).toEqual([
      { group: "compute.trigger.dev", version: "v1alpha1", namespace: "runs", plural: "runners" },
    ]);
    expect(killed.map(([runnerId, kill]) => [runnerId, kill.code, kill.runFriendlyId])).toEqual([
      ["runner-oom", "TASK_PROCESS_OOM_KILLED", "run_a"],
      ["runner-kill", "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE", "run_b"],
    ]);
  });
});

describe("RunnerKillInformer start failures", () => {
  function templateMissing(name: string, labels?: Record<string, string>) {
    const runner = failedRunner(
      name,
      "TemplateNotFound",
      "template abc is not available on node node-a: not in the store",
      "run_a"
    );
    return {
      ...runner,
      metadata: { ...runner.metadata, ...(labels ? { labels } : {}) },
      spec: { ...runner.spec, bootstrap: { runFriendlyID: "run_a", snapshotFriendlyID: "snap_a" } },
    } as KubernetesObject;
  }

  it("passes on a cold start whose template is missing once, and not as a kill", async () => {
    const cold = templateMissing("runner-cold");
    const { k8s, watchCallbacks } = fakeK8s([
      cold,
      templateMissing("runner-resume", { [RESTORE_LABEL]: "true" }),
    ]);
    const killed: string[] = [];
    const failed: RunnerStartFailure[] = [];
    const informer = new RunnerKillInformer({
      namespace: "runs",
      k8s,
      onRunnerKilled: (runnerId) => killed.push(runnerId),
      onRunnerStartFailed: (failure) => failed.push(failure),
    });

    await informer.start();
    await vi.waitFor(() => expect(failed).toHaveLength(1));
    await vi.waitFor(() => expect(watchCallbacks).toHaveLength(1));
    watchCallbacks[0]!("MODIFIED", {
      ...cold,
      metadata: { ...cold.metadata, resourceVersion: "2" },
    });
    await informer.stop();

    expect(killed).toEqual([]);
    expect(
      failed.map((f) => [f.runnerId, f.runFriendlyId, f.snapshotFriendlyId, f.outcome.uid])
    ).toEqual([["runner-cold", "run_a", "snap_a", "runner-cold-uid"]]);
  });

  it("passes on nothing for it without a start failure handler", async () => {
    const { k8s, watchCallbacks } = fakeK8s([templateMissing("runner-cold")]);
    const killed: string[] = [];
    const informer = new RunnerKillInformer({
      namespace: "runs",
      k8s,
      onRunnerKilled: (runnerId) => killed.push(runnerId),
    });

    await informer.start();
    // The watch starts once the list is handled.
    await vi.waitFor(() => expect(watchCallbacks).toHaveLength(1));
    await informer.stop();

    expect(killed).toEqual([]);
  });
});
