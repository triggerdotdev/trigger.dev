import {
  ApiException,
  ListWatch,
  type KubernetesObject,
  type ListPromise,
  type V1Pod,
  type Watch,
} from "@kubernetes/client-node";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Registry } from "prom-client";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { K8sApi } from "../clients/kubernetes.js";
import { FailedPodHandler } from "./failedPodHandler.js";
import { dequeuedRun, runOfPod, RunReleaser } from "./runReleases.js";

function failedPod(
  name: string,
  exitCode: number,
  env: Record<string, string> = {
    TRIGGER_RUN_ID: "run_a",
    TRIGGER_SNAPSHOT_ID: "snapshot_a",
    TRIGGER_ENV_ID: "env_a",
  }
): KubernetesObject {
  const pod: V1Pod = {
    metadata: { name, namespace: "runs", uid: `${name}-uid` },
    spec: {
      containers: [
        {
          name: "run-controller",
          env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
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
          state: { terminated: { exitCode, reason: "Error", finishedAt: new Date() } },
        },
      ],
    },
  };
  return pod as KubernetesObject;
}

type DeleteOptions = { gracePeriodSeconds?: number; preconditions?: { uid?: string } };

/** A K8sApi whose pod list returns `items`, recording each pod deletion in `events`. */
function fakeK8s(
  items: KubernetesObject[],
  events: string[],
  {
    deleteError,
    deletes = [],
  }: { deleteError?: Error; deletes?: (DeleteOptions | undefined)[] } = {}
) {
  const watch = { watch: async () => ({ abort: () => {} }) };
  const list = async () => ({ items, metadata: { resourceVersion: "1" } });
  return {
    makeInformer: (path: string, listFn: ListPromise<KubernetesObject>, selector?: string) =>
      new ListWatch(path, watch as unknown as Watch, listFn, false, selector),
    core: {
      listNamespacedPod: list,
      deleteNamespacedPod: async ({ name, body }: { name: string; body?: DeleteOptions }) => {
        events.push(`delete:${name}`);
        deletes.push(body);
        if (deleteError) {
          throw deleteError;
        }
        return {};
      },
    },
  } as unknown as K8sApi;
}

/** What client-node raises for a non-2xx answer. */
function apiError(code: number) {
  return new ApiException(code, "Unknown API Status Code!", JSON.stringify({ code }), {});
}

type Answer = { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

/** A worker API that answers each release with `answer` and records it in `events`. */
async function workerApi(
  answer: Answer | ((url: string) => Answer),
  events: string[],
  { runsReleasedAMinute = 5 } = {}
) {
  const requests: { url?: string; headers: IncomingMessage["headers"]; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    events.push(`release:${req.url}`);
    const answered = typeof answer === "function" ? answer(req.url ?? "") : answer;
    if (answered.delayMs) {
      await setTimeout(answered.delayMs);
    }
    res.writeHead(answered.status, { "content-type": "application/json", ...answered.headers });
    res.end(JSON.stringify(answered.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new SupervisorHttpClient({
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    workerToken: "tr_wgt_test",
    instanceName: "test",
  });
  const register = new Registry();
  return {
    requests,
    register,
    releaser: new RunReleaser({ client: () => client, register, runsReleasedAMinute }),
  };
}

async function releaseResults(register: Registry) {
  const metric = await register.getSingleMetric("supervisor_run_releases_total")?.get();
  return Object.fromEntries(
    (metric?.values ?? []).map(({ labels, value }) => [`${labels.reason}/${labels.result}`, value])
  );
}

/** Runs the handler over `pods` until each is deleted and `releases` runs were released. */
async function handleFailedPods(
  pods: KubernetesObject[],
  releaser: RunReleaser,
  events: string[],
  { releases = pods.length, deleteError }: { releases?: number; deleteError?: Error } = {}
) {
  let settled = 0;
  const deletes: DeleteOptions[] = [];
  const register = new Registry();
  const handler = new FailedPodHandler({
    namespace: "runs",
    register,
    k8s: fakeK8s(pods, events, { deleteError, deletes }),
    onRunPodFailed: async (pod) => {
      await releaser.release(pod, "PodFailed");
      settled++;
    },
  });
  await handler.start();
  await vi.waitFor(
    () => {
      expect(events.filter((e) => e.startsWith("delete:"))).toHaveLength(pods.length);
      expect(settled).toBe(releases);
    },
    { timeout: 5_000, interval: 20 }
  );
  // Long enough for a release that should not happen to have started.
  await setTimeout(50);
  await handler.stop();
  expect(settled).toBe(releases);
  return {
    deletes,
    deleted: await counterValue(register, "failed_pod_handler_deleted_pods_total"),
    deleteErrors: await counterValue(register, "failed_pod_handler_deletion_errors_total"),
  };
}

async function counterValue(register: Registry, name: string) {
  const metric = await register.getSingleMetric(name)?.get();
  return (metric?.values ?? []).reduce((sum, { value }) => sum + value, 0);
}

describe("releasing the run of a pod that failed before it started", () => {
  it("releases the pod's run at its dequeued snapshot once the pod is deleted", async () => {
    const events: string[] = [];
    const { requests, register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    const handled = await handleFailedPods([failedPod("runner-a", 1)], releaser, events);

    expect(events).toEqual([
      "delete:runner-a",
      "release:/engine/v1/worker-actions/runs/run_a/snapshots/snapshot_a/release",
    ]);
    // At once, since the run's next pod takes the name; only this pod, never a replacement.
    expect(handled.deletes).toEqual([{ preconditions: { uid: "runner-a-uid" } }]);
    expect(handled).toMatchObject({ deleted: 1, deleteErrors: 0 });
    expect(requests[0]?.body).toEqual({ reason: "PodFailed" });
    expect(requests[0]?.headers).toMatchObject({
      "x-trigger-worker-runner-id": "runner-a",
      "x-trigger-worker-environment-id": "env_a",
    });
    expect(await releaseResults(register)).toEqual({ "PodFailed/released": 1 });
  });

  it("releases nothing for a pod that shut down gracefully or does not name its snapshot", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    await handleFailedPods(
      [
        failedPod("runner-graceful", FailedPodHandler.GRACEFUL_SHUTDOWN_EXIT_CODE),
        failedPod("runner-unnamed", 1, { TRIGGER_RUN_ID: "run_a", TRIGGER_ENV_ID: "env_a" }),
      ],
      releaser,
      events,
      { releases: 0 }
    );

    expect(events.filter((e) => e.startsWith("release:"))).toEqual([]);
    expect(await releaseResults(register)).toEqual({});
  });

  it.each([404, 409])(
    "without a release, deletes a pod as before: by name alone, counting a %i as a failure",
    async (code) => {
      const events: string[] = [];
      const deletes: (DeleteOptions | undefined)[] = [];
      const register = new Registry();
      const pod = failedPod("runner-a", 1) as V1Pod;
      const handler = new FailedPodHandler({
        namespace: "runs",
        register,
        k8s: fakeK8s([pod], events, { deleteError: apiError(code), deletes }),
      });

      await handler.start();
      await vi.waitFor(() => expect(events).toEqual(["delete:runner-a"]), {
        timeout: 5_000,
        interval: 20,
      });
      await handler.stop();

      expect(deletes).toEqual([undefined]);
      expect(await counterValue(register, "failed_pod_handler_deletion_errors_total")).toBe(1);
      expect(await counterValue(register, "failed_pod_handler_deleted_pods_total")).toBe(0);
    }
  );

  it("releases the run of a pod that is already gone, since its name is free", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    const handled = await handleFailedPods([failedPod("runner-a", 1)], releaser, events, {
      deleteError: apiError(404),
    });

    expect(events).toEqual([
      "delete:runner-a",
      "release:/engine/v1/worker-actions/runs/run_a/snapshots/snapshot_a/release",
    ]);
    expect(handled).toMatchObject({ deleted: 0, deleteErrors: 0 });
    expect(await releaseResults(register)).toEqual({ "PodFailed/released": 1 });
  });

  it.each([
    ["a newer pod holds its name", apiError(409), 0],
    ["it could not be deleted", new Error("delete failed"), 1],
  ])(
    "releases nothing when %s, since its run's next pod takes its name",
    async (_name, error, deleteErrors) => {
      const events: string[] = [];
      const { register, releaser } = await workerApi(
        { status: 200, body: { ok: true, requeued: true } },
        events
      );

      const handled = await handleFailedPods([failedPod("runner-a", 1)], releaser, events, {
        releases: 0,
        deleteError: error,
      });

      expect(events).toEqual(["delete:runner-a"]);
      expect(handled).toMatchObject({ deleted: 0, deleteErrors });
      expect(await releaseResults(register)).toEqual({});
    }
  );

  it.each([
    { answer: { status: 200, body: { ok: true, requeued: false } }, result: "dropped" },
    {
      answer: { status: 409, body: { error: "moved on" }, headers: { "x-should-retry": "false" } },
      result: "conflict",
    },
    { answer: { status: 404, body: { error: "Not Found" } }, result: "unavailable" },
    {
      answer: { status: 500, body: { error: "boom" }, headers: { "x-should-retry": "false" } },
      result: "error",
    },
  ])("counts a $answer.status answer as $result", async (kase) => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(kase.answer, events);

    await handleFailedPods([failedPod("runner-a", 1)], releaser, events);

    expect(events).toEqual([
      "delete:runner-a",
      "release:/engine/v1/worker-actions/runs/run_a/snapshots/snapshot_a/release",
    ]);
    expect(await releaseResults(register)).toEqual({ [`PodFailed/${kase.result}`]: 1 });
  });
});

/** The run `n` of a dequeued message, at its dequeued snapshot. */
function runN(n: number) {
  return dequeuedRun({
    run: { friendlyId: `run_${n}`, attemptNumber: 1 },
    snapshot: { friendlyId: `snapshot_${n}` },
    environment: { id: "env_b" },
    deployment: { friendlyId: "deployment_b" },
  } as DequeuedMessage);
}

describe("the run of a failed pod", () => {
  it("is read from the run-controller container's env, with its deployment when named", () => {
    const named = failedPod("runner-a", 1, {
      TRIGGER_RUN_ID: "run_a",
      TRIGGER_SNAPSHOT_ID: "snapshot_a",
      TRIGGER_ENV_ID: "env_a",
      TRIGGER_DEPLOYMENT_FRIENDLY_ID: "deployment_a",
    }) as V1Pod;
    expect(runOfPod(named)).toEqual({
      runnerId: "runner-a",
      runFriendlyId: "run_a",
      snapshotFriendlyId: "snapshot_a",
      environmentId: "env_a",
      deploymentFriendlyId: "deployment_a",
    });

    expect(runOfPod(failedPod("runner-b", 1) as V1Pod)).toMatchObject({
      runFriendlyId: "run_a",
      deploymentFriendlyId: undefined,
    });
  });
});

describe("releasing a run whose workload could not be created", () => {
  it("releases the run at its dequeued snapshot, naming the runner its create used", async () => {
    const events: string[] = [];
    const { requests, register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );
    const message = {
      run: { friendlyId: "run_b", attemptNumber: 2 },
      snapshot: { friendlyId: "snapshot_b" },
      environment: { id: "env_b" },
      deployment: { friendlyId: "deployment_b" },
    } as DequeuedMessage;

    expect(await releaser.release(dequeuedRun(message), "CreateFailed")).toBe("released");

    expect(events).toEqual([
      "release:/engine/v1/worker-actions/runs/run_b/snapshots/snapshot_b/release",
    ]);
    expect(requests[0]?.body).toEqual({ reason: "CreateFailed" });
    expect(requests[0]?.headers).toMatchObject({
      "x-trigger-worker-runner-id": "runner-b-attempt-2",
      "x-trigger-worker-environment-id": "env_b",
    });
    expect(await releaseResults(register)).toEqual({ "CreateFailed/released": 1 });
  });

  it("withholds releases once five different runs were released within a minute", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const results: string[] = [];
      for (let n = 1; n <= 7; n++) {
        vi.setSystemTime(Date.now() + 5_000);
        results.push(await releaser.release(runN(n), "CreateFailed"));
      }
      expect(results).toEqual([
        "released",
        "released",
        "released",
        "released",
        "released",
        "withheld",
        "withheld",
      ]);
      expect(events).toHaveLength(5);

      // A run released earlier waits too while the minute's releases are used up.
      vi.setSystemTime(Date.now() + 5_000);
      expect(await releaser.release(runN(1), "CreateFailed")).toBe("withheld");

      // A minute after the fifth release the window is clear, since withheld runs never counted.
      vi.setSystemTime(Date.now() + 56_000);
      for (let n = 8; n <= 12; n++) {
        expect(await releaser.release(runN(n), "CreateFailed")).toBe("released");
      }
      expect(await releaser.release(runN(13), "CreateFailed")).toBe("withheld");
    } finally {
      vi.useRealTimers();
    }

    expect(await releaseResults(register)).toEqual({
      "CreateFailed/released": 10,
      "CreateFailed/withheld": 4,
    });
  });

  it("forgets a release exactly a minute later", async () => {
    const events: string[] = [];
    const { releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let n = 1; n <= 5; n++) {
        expect(await releaser.release(runN(n), "CreateFailed")).toBe("released");
      }
      expect(await releaser.release(runN(6), "CreateFailed")).toBe("withheld");
      vi.setSystemTime(Date.now() + 59_999);
      expect(await releaser.release(runN(7), "CreateFailed")).toBe("withheld");
      vi.setSystemTime(Date.now() + 1);
      expect(await releaser.release(runN(8), "CreateFailed")).toBe("released");
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees one slot at a time, a minute after each release", async () => {
    const events: string[] = [];
    const { releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let n = 1; n <= 5; n++) {
        vi.setSystemTime(Date.now() + 5_000);
        expect(await releaser.release(runN(n), "CreateFailed")).toBe("released");
      }
      // The first release is a minute old, the others are not.
      vi.setSystemTime(Date.now() + 40_000);
      expect(await releaser.release(runN(6), "CreateFailed")).toBe("released");
      expect(await releaser.release(runN(7), "CreateFailed")).toBe("withheld");
      vi.setSystemTime(Date.now() + 5_000);
      expect(await releaser.release(runN(8), "CreateFailed")).toBe("released");
      expect(await releaser.release(runN(9), "CreateFailed")).toBe("withheld");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases exactly five of a burst in flight and withholds the rest", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true }, delayMs: 50 },
      events
    );

    const burst = await Promise.all(
      Array.from({ length: 7 }, (_, i) => releaser.release(runN(i + 1), "CreateFailed"))
    );

    expect(burst.filter((r) => r === "released")).toHaveLength(5);
    expect(burst.filter((r) => r === "withheld")).toHaveLength(2);
    expect(events).toHaveLength(5);
    expect(await releaser.release(runN(8), "CreateFailed")).toBe("withheld");
    expect(await releaseResults(register)).toEqual({
      "CreateFailed/released": 5,
      "CreateFailed/withheld": 3,
    });
  });

  it.each([
    ["has no release", 404, "unavailable"],
    ["cannot release it", 500, "error"],
  ] as const)(
    "gives a run's place back when the platform %s, so the next runs go through",
    async (_, status, result) => {
      const events: string[] = [];
      const { register, releaser } = await workerApi(
        (url) =>
          /\/runs\/run_[1-5]\//.test(url)
            ? { status, body: { error: "no" }, headers: { "x-should-retry": "false" } }
            : { status: 200, body: { ok: true, requeued: true } },
        events
      );

      for (let n = 1; n <= 5; n++) {
        expect(await releaser.release(runN(n), "CreateFailed")).toBe(result);
      }
      for (let n = 6; n <= 10; n++) {
        expect(await releaser.release(runN(n), "CreateFailed")).toBe("released");
      }
      expect(await releaser.release(runN(11), "CreateFailed")).toBe("withheld");
      expect(await releaseResults(register)).toEqual({
        [`CreateFailed/${result}`]: 5,
        "CreateFailed/released": 5,
        "CreateFailed/withheld": 1,
      });
    }
  );

  it("counts a run once while two of its releases are in flight", async () => {
    const events: string[] = [];
    const { releaser } = await workerApi(
      (url) =>
        /\/runs\/run_1\//.test(url)
          ? {
              status: 409,
              body: { error: "moved on" },
              headers: { "x-should-retry": "false" },
              delayMs: 50,
            }
          : { status: 200, body: { ok: true, requeued: true } },
      events,
      { runsReleasedAMinute: 2 }
    );

    const twice = await Promise.all([
      releaser.release(runN(1), "CreateFailed"),
      releaser.release(runN(1), "PodFailed"),
    ]);

    expect(twice).toEqual(["conflict", "conflict"]);
    expect(await releaser.release(runN(2), "CreateFailed")).toBe("released");
    expect(await releaser.release(runN(3), "CreateFailed")).toBe("released");
    expect(await releaser.release(runN(4), "CreateFailed")).toBe("withheld");
  });

  it("counts a run released earlier once while its next release is in flight", async () => {
    const events: string[] = [];
    let firstRunCalls = 0;
    const { releaser } = await workerApi(
      (url) =>
        /\/runs\/run_1\//.test(url) && ++firstRunCalls > 1
          ? {
              status: 409,
              body: { error: "moved on" },
              headers: { "x-should-retry": "false" },
              delayMs: 50,
            }
          : { status: 200, body: { ok: true, requeued: true } },
      events,
      { runsReleasedAMinute: 2 }
    );
    expect(await releaser.release(runN(1), "CreateFailed")).toBe("released");

    const [again, other] = await Promise.all([
      releaser.release(runN(1), "CreateFailed"),
      releaser.release(runN(2), "CreateFailed"),
    ]);

    expect(again).toBe("conflict");
    expect(other).toBe("released");
    expect(await releaser.release(runN(3), "CreateFailed")).toBe("withheld");
  });

  it("counts a release from when the platform applied it, not from when it was sent", async () => {
    const events: string[] = [];
    const { releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true }, delayMs: 50 },
      events,
      { runsReleasedAMinute: 1 }
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const sent = releaser.release(runN(1), "CreateFailed");
      vi.setSystemTime(Date.now() + 60_000);
      expect(await sent).toBe("released");
      expect(await releaser.release(runN(2), "CreateFailed")).toBe("withheld");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the place of a release the platform applied but could not requeue", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: false } },
      events,
      { runsReleasedAMinute: 1 }
    );

    expect(await releaser.release(runN(1), "CreateFailed")).toBe("dropped");
    expect(await releaser.release(runN(2), "CreateFailed")).toBe("withheld");
    expect(await releaseResults(register)).toEqual({
      "CreateFailed/dropped": 1,
      "CreateFailed/withheld": 1,
    });
  });

  it("takes its limit from its options, freeing the one slot a minute later", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events,
      { runsReleasedAMinute: 1 }
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await releaser.release(runN(1), "CreateFailed")).toBe("released");
      expect(await releaser.release(runN(2), "CreateFailed")).toBe("withheld");
      expect(await releaser.release(runN(1), "CreateFailed")).toBe("withheld");
      vi.setSystemTime(Date.now() + 59_999);
      expect(await releaser.release(runN(2), "CreateFailed")).toBe("withheld");
      vi.setSystemTime(Date.now() + 1);
      expect(await releaser.release(runN(2), "CreateFailed")).toBe("released");
      expect(await releaser.release(runN(3), "CreateFailed")).toBe("withheld");
    } finally {
      vi.useRealTimers();
    }

    expect(events).toHaveLength(2);
    expect(await releaseResults(register)).toEqual({
      "CreateFailed/released": 2,
      "CreateFailed/withheld": 4,
    });
  });

  it("withholds every release with a limit of 0", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events,
      { runsReleasedAMinute: 0 }
    );

    expect(await releaser.release(runN(1), "CreateFailed")).toBe("withheld");
    expect(await releaser.release(runN(2), "PodFailed")).toBe("withheld");

    expect(events).toEqual([]);
    expect(await releaseResults(register)).toEqual({
      "CreateFailed/withheld": 1,
      "PodFailed/withheld": 1,
    });
  });

  it("never withholds one run that fails on each delivery, under the default limit", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );

    for (let i = 0; i < 8; i++) {
      expect(await releaser.release(runN(1), "CreateFailed")).toBe("released");
    }

    expect(events).toHaveLength(8);
    expect(await releaseResults(register)).toEqual({ "CreateFailed/released": 8 });
  });

  it("counts failed pods and refused creates in the same window", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      { status: 200, body: { ok: true, requeued: true } },
      events
    );
    for (let n = 1; n <= 3; n++) {
      expect(await releaser.release(runN(n), "CreateFailed")).toBe("released");
    }
    for (let n = 4; n <= 5; n++) {
      expect(await releaser.release(runN(n), "PodFailed")).toBe("released");
    }

    expect(await releaser.release(runN(6), "PodFailed")).toBe("withheld");
    expect(await releaser.release(runN(7), "CreateFailed")).toBe("withheld");
    expect(await releaseResults(register)).toEqual({
      "CreateFailed/released": 3,
      "CreateFailed/withheld": 1,
      "PodFailed/released": 2,
      "PodFailed/withheld": 1,
    });
  });

  it("counts only releases the platform applied, so failed pods of started runs leave the window alone", async () => {
    const events: string[] = [];
    const { register, releaser } = await workerApi(
      (url) =>
        /\/runs\/run_[1-5]\//.test(url)
          ? { status: 409, body: { error: "moved on" }, headers: { "x-should-retry": "false" } }
          : { status: 200, body: { ok: true, requeued: true } },
      events
    );
    for (let n = 1; n <= 5; n++) {
      expect(await releaser.release(runN(n), "PodFailed")).toBe("conflict");
    }

    for (let n = 6; n <= 10; n++) {
      expect(await releaser.release(runN(n), "CreateFailed")).toBe("released");
    }
    expect(await releaser.release(runN(11), "CreateFailed")).toBe("withheld");
    expect(await releaseResults(register)).toEqual({
      "PodFailed/conflict": 5,
      "CreateFailed/released": 5,
      "CreateFailed/withheld": 1,
    });
  });
});
