import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import {
  RESTORE_LABEL,
  RunCrdWorkloadManager,
  RunnerRestoreInformer,
  SUSPEND_ANNOTATION,
  SUSPEND_RUN_ANNOTATION,
  SUSPEND_SUBMITTED_ANNOTATION,
  awaitRestoreOf,
  checkpointLocation,
  classifyRestoreFailure,
  parseCheckpointLocation,
  pollDelayMs,
  publishedSuspend,
  restoreHeartbeat,
  restoreOutcome,
  runnerBodyFor,
  runnerTokenSecretName,
  settleRestoreFailure,
  suspendOutcome,
} from "./runCrd.js";
import {
  ListWatch,
  type KubernetesObject,
  type ListPromise,
  type Watch,
} from "@kubernetes/client-node";
import type { K8sApi } from "../clients/kubernetes.js";
import { getRestoreRunnerId, getRunnerId } from "../util.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

const createRunner = vi.fn();
const deleteRunner = vi.fn();
const getRunner = vi.fn();
const listRunners = vi.fn();
const patchObject = vi.fn();
const createSecret = vi.fn();
const deleteSecret = vi.fn();

vi.mock("../clients/kubernetes.js", () => ({
  createK8sApi: () => ({
    core: { createNamespacedSecret: createSecret, deleteNamespacedSecret: deleteSecret },
    custom: {
      createNamespacedCustomObject: createRunner,
      deleteNamespacedCustomObject: deleteRunner,
      getNamespacedCustomObject: getRunner,
      listNamespacedCustomObject: listRunners,
    },
    objects: { patch: patchObject },
  }),
}));

const meta = { name: "runner-abc123", namespace: "v4-runs", runtime: "container" } as const;

function createOptions(
  overrides: Partial<WorkloadManagerCreateOptions> = {}
): WorkloadManagerCreateOptions {
  return {
    image: "registry.example.com/proj/worker:20260827.1@sha256:" + "0".repeat(64),
    machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
    version: "20260827.1",
    dequeuedAt: new Date("2026-08-27T03:00:00.000Z"),
    envId: "env_abc",
    envType: "PRODUCTION",
    orgId: "org_abc",
    projectId: "proj_abc",
    deploymentFriendlyId: "deployment_abc",
    deploymentVersion: "20260827.1",
    runId: "run_internal",
    runFriendlyId: "run_abc123",
    snapshotId: "snapshot_internal",
    snapshotFriendlyId: "snapshot_abc",
    ...overrides,
  };
}

/**
 * The one spec field a cell chooses rather than derives from the run. Both values
 * are asserted because a hardcoded "container" passes a test that only asks for one.
 */
describe("runnerBodyFor carries the isolation lane it is given", () => {
  it.each(["container", "microvm"] as const)("asks for %s", (runtime) => {
    const body = runnerBodyFor(createOptions(), { ...meta, runtime });

    expect(body.spec.runtime).toBe(runtime);
  });

  it("leaves the task runtime alone, which is a different field", () => {
    const body = runnerBodyFor(createOptions({ runtime: "node-24" }), {
      ...meta,
      runtime: "microvm",
    });

    expect(body.spec.runtime).toBe("microvm");
    expect(body.spec.taskRuntime).toBe("node-24");
  });
});

/**
 * Asserted here because the type cannot: create() passes a variable, and
 * TypeScript's excess property check only applies to object literals.
 */
describe("runnerBodyFor sends only what the CRD declares", () => {
  it("takes only name and key from a wider token handle", () => {
    const body = runnerBodyFor(createOptions(), {
      ...meta,
      token: { name: "runner-abc123-token-deadbeef", key: "token", uid: "uid-not-in-the-crd" } as {
        name: string;
        key: string;
      },
    });

    expect(body.spec.deployment.token).toEqual({
      name: "runner-abc123-token-deadbeef",
      key: "token",
    });
  });

  it("omits the token entirely when there is none", () => {
    const body = runnerBodyFor(createOptions(), meta);

    expect(body.spec.deployment).not.toHaveProperty("token");
  });
});

describe("runnerBodyFor", () => {
  it("names the object after the runner and carries the required spec", () => {
    const body = runnerBodyFor(createOptions(), meta);

    expect(body.apiVersion).toBe("compute.trigger.dev/v1alpha1");
    expect(body.kind).toBe("Runner");
    expect(body.metadata).toEqual({ name: "runner-abc123", namespace: "v4-runs" });
    expect(body.spec.runtime).toBe("container");
    expect(body.spec.deployment).toEqual({
      friendlyID: "deployment_abc",
      version: "20260827.1",
    });
    expect(body.spec.owner).toEqual({
      envID: "env_abc",
      envType: "PRODUCTION",
      orgID: "org_abc",
      projectID: "proj_abc",
    });
  });

  // Stripping it here would submit a reference the API's tag-or-digest pattern
  // rejects, and two appliers would eventually both apply.
  it("sends the image reference as built, digest and all", () => {
    const opts = createOptions();
    expect(runnerBodyFor(opts, meta).spec.image).toBe(opts.image);
  });

  // The preset table is decimal gigabytes, and no integer count of binary MiB
  // equals a quarter of one.
  it("sends the preset's own figures in the preset's own units", () => {
    expect(runnerBodyFor(createOptions(), meta).spec.machine).toEqual({
      name: "small-1x",
      cpu: "0.5",
      memory: "0.5G",
    });

    const micro = createOptions({
      machine: { name: "micro", cpu: 0.25, memory: 0.25, centsPerMs: 0 },
    });
    expect(runnerBodyFor(micro, meta).spec.machine).toEqual({
      name: "micro",
      cpu: "0.25",
      memory: "0.25G",
    });
  });

  // The runner it creates goes on to serve however many later runs the
  // warm-start path hands it, so this run is the bootstrap and nothing more.
  it("puts the run that caused the runner in bootstrap", () => {
    expect(runnerBodyFor(createOptions(), meta).spec.bootstrap).toEqual({
      runFriendlyID: "run_abc123",
      snapshotFriendlyID: "snapshot_abc",
      dequeuedAt: "2026-08-27T03:00:00.000Z",
    });
  });

  // A credential in the spec is readable by anything holding get on the
  // resource and kept for as long as the object is.
  it("references the deployment token and never carries it", () => {
    const body = runnerBodyFor(createOptions({ deploymentToken: "tok_secret" }), {
      ...meta,
      token: { name: "deployment-token-deployment_abc", key: "token" },
    });

    expect(body.spec.deployment.token).toEqual({
      name: "deployment-token-deployment_abc",
      key: "token",
    });
    expect(JSON.stringify(body)).not.toContain("tok_secret");
  });

  it("omits the token reference when no token was issued", () => {
    expect(runnerBodyFor(createOptions(), meta).spec.deployment).not.toHaveProperty("token");
  });

  // Empty is treated as neither bun nor a node version; a made-up default would
  // change which uid the container is pinned to.
  it("omits the task runtime rather than inventing one", () => {
    expect(runnerBodyFor(createOptions(), meta).spec).not.toHaveProperty("taskRuntime");
    expect(runnerBodyFor(createOptions({ runtime: "bun" }), meta).spec.taskRuntime).toBe("bun");
  });

  // Only the first value reaches a node selector, so the list would describe a
  // choice nothing makes.
  it("flattens each placement tag to its first value", () => {
    const opts = createOptions({
      placementTags: [
        { key: "pool", values: ["spot", "ondemand"] },
        { key: "zone", values: [] },
      ],
    });
    expect(runnerBodyFor(opts, meta).spec.placementTags).toEqual([
      { key: "pool", value: "spot" },
      { key: "zone", value: "" },
    ]);
  });

  it("omits placement tags when there are none", () => {
    expect(runnerBodyFor(createOptions(), meta).spec).not.toHaveProperty("placementTags");
    expect(runnerBodyFor(createOptions({ placementTags: [] }), meta).spec).not.toHaveProperty(
      "placementTags"
    );
  });

  // It decides node-pool affinity and tolerations for every run this runner
  // later serves, not only the one that started it.
  it("carries the scheduled flag derived from the bootstrap run's source", () => {
    const scheduled = createOptions({
      annotations: {
        triggerSource: "schedule",
        triggerAction: "trigger",
        rootTriggerSource: "schedule",
      },
    });
    expect(runnerBodyFor(scheduled, meta).spec.isScheduledRun).toBe(true);

    const api = createOptions({
      annotations: { triggerSource: "api", triggerAction: "trigger", rootTriggerSource: "api" },
    });
    expect(runnerBodyFor(api, meta).spec).not.toHaveProperty("isScheduledRun");
    expect(runnerBodyFor(createOptions(), meta).spec).not.toHaveProperty("isScheduledRun");
  });

  // Setting it where no policy exists flips the pod to default-deny with
  // nothing allowed, so it is an assertion rather than a hint.
  it("carries the private link flag only when set", () => {
    expect(runnerBodyFor(createOptions({ hasPrivateLink: true }), meta).spec.hasPrivateLink).toBe(
      true
    );
    expect(runnerBodyFor(createOptions(), meta).spec).not.toHaveProperty("hasPrivateLink");
  });

  // The operator reads neither a trace context nor an attempt number (the attempt is
  // in the name), and an unread field drifts from reality unnoticed.
  it("sends nothing the operator does not read", () => {
    const opts = createOptions({
      nextAttemptNumber: 3,
      traceContext: { traceparent: "00-abc-def-01" },
      dequeueResponseMs: 12,
      pollingIntervalMs: 500,
      warmStartCheckMs: 3,
      runtime: "node-22",
    });
    const spec = runnerBodyFor(opts, meta).spec;

    expect(Object.keys(spec).sort()).toEqual(
      ["bootstrap", "deployment", "image", "machine", "owner", "runtime", "taskRuntime"].sort()
    );
  });
});

/**
 * A resume is the cold-start Runner plus the snapshot to restore from; the
 * operator adds nothing else to the pod for it, so nothing else may differ.
 */
describe("runnerBodyFor builds a resume", () => {
  const restore = { snapshotID: "6f1c2a9e-snap", node: "node-a" };

  it("names the snapshot to restore from and the node holding it", () => {
    const body = runnerBodyFor(createOptions(), { ...meta, runtime: "microvm", restore });

    expect(body.spec.restore).toEqual({ snapshotID: "6f1c2a9e-snap", node: "node-a" });
  });

  // The restore informer selects on this label and misses any resume without it.
  it("labels a resume, and only a resume, as a restore", () => {
    const resume = runnerBodyFor(createOptions(), { ...meta, runtime: "microvm", restore });
    const cold = runnerBodyFor(createOptions(), { ...meta, runtime: "microvm" });

    expect(resume.metadata.labels).toEqual({ [RESTORE_LABEL]: "true" });
    expect(cold.metadata).not.toHaveProperty("labels");
  });

  it("differs from a cold start only by the restore", () => {
    const cold = runnerBodyFor(createOptions(), { ...meta, runtime: "microvm" });
    const { restore: _, ...resume } = runnerBodyFor(createOptions(), {
      ...meta,
      runtime: "microvm",
      restore,
    }).spec;

    expect(resume).toEqual(cold.spec);
  });

  // A retried restore must collide with the first rather than restore twice,
  // and the name has to pass as a Runner name and seed a legal Secret name.
  it("is named from the checkpoint, legally for the Runner and its token", () => {
    const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    const run = generateFriendlyId("run");
    const checkpoint = generateFriendlyId("checkpoint");

    const name = getRestoreRunnerId(run, checkpoint);
    expect(name).toBe(getRestoreRunnerId(run, checkpoint));
    expect(name).not.toBe(getRestoreRunnerId(run, generateFriendlyId("checkpoint")));
    expect(name).not.toBe(getRunnerId(run));
    expect(name).toMatch(DNS1123);
    expect(runnerTokenSecretName(name, "tok")).toMatch(DNS1123);
  });
});

describe("runnerTokenSecretName", () => {
  /** What the API server enforces on a Secret name. */
  const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

  it("derives one name per runner, so no two runners share a Secret", () => {
    expect(runnerTokenSecretName("runner-abc123", "tok")).toBe(
      runnerTokenSecretName("runner-abc123", "tok")
    );
    // The point of the whole scheme: a second runner on the same deployment
    // token gets its own object, so nothing can be collected from under it.
    expect(runnerTokenSecretName("runner-abc123", "tok")).not.toBe(
      runnerTokenSecretName("runner-def456", "tok")
    );
  });

  it("does not repeat a digest across runners holding the same token", () => {
    const digestOf = (name: string) => name.split("-token-")[1];
    // Mixed with the runner id, so a listing cannot say which runners share a
    // deployment token.
    expect(digestOf(runnerTokenSecretName("runner-abc123", "tok"))).not.toBe(
      digestOf(runnerTokenSecretName("runner-def456", "tok"))
    );
  });

  it("separates attempts of the same run", () => {
    expect(runnerTokenSecretName(getRunnerId("run_abc123"), "tok")).not.toBe(
      runnerTokenSecretName(getRunnerId("run_abc123", 2), "tok")
    );
  });

  it("is a legal Secret name for a real runner id", () => {
    const name = runnerTokenSecretName(getRunnerId(generateFriendlyId("run")), "tok");
    expect(name).toMatch(DNS1123);
    expect(name).not.toContain("_");
  });

  it("lowercases, because a Secret name is a DNS subdomain", () => {
    expect(runnerTokenSecretName("Runner-ABC123", "tok")).toMatch(DNS1123);
  });

  it("changes when the token does, because the Secret is immutable", () => {
    expect(runnerTokenSecretName("runner-abc123", "before")).not.toBe(
      runnerTokenSecretName("runner-abc123", "after")
    );
  });
});

/**
 * Every create-option field either changes the Runner `runnerBodyFor` builds or is
 * in RUN_CRD_EXCLUDED with a reason, so an optional field the type checker accepts
 * cannot be silently dropped. Checked by probing behaviour rather than scanning
 * source, which a comment or an unrelated `opts.<field>` reference would fool.
 */
describe("run-crd carries every shared create-option or excludes it on purpose", () => {
  /** Every key of WorkloadManagerCreateOptions; KEYS_ARE_EXHAUSTIVE fails to compile otherwise. */
  const CREATE_OPTION_KEYS = [
    "image",
    "machine",
    "version",
    "nextAttemptNumber",
    "dequeuedAt",
    "placementTags",
    "dequeueResponseMs",
    "pollingIntervalMs",
    "warmStartCheckMs",
    "envId",
    "envType",
    "orgId",
    "projectId",
    "deploymentFriendlyId",
    "deploymentVersion",
    "runtime",
    "deploymentToken",
    "runId",
    "runFriendlyId",
    "snapshotId",
    "snapshotFriendlyId",
    "snapshotRoute",
    "traceContext",
    "annotations",
    "hasPrivateLink",
  ] as const satisfies readonly (keyof WorkloadManagerCreateOptions)[];

  type ListedKey = (typeof CREATE_OPTION_KEYS)[number];
  type MissingKey = Exclude<keyof WorkloadManagerCreateOptions, ListedKey>;
  const KEYS_ARE_EXHAUSTIVE: [MissingKey] extends [never] ? true : ["unlisted keys", MissingKey] =
    true;

  /**
   * Fields that do not change the spec, each with its reason. Some still shape
   * creation by another route, such as the runner's name or its token Secret.
   */
  const RUN_CRD_EXCLUDED: Partial<Record<ListedKey, string>> = {
    snapshotRoute:
      "Superseded transport, not a run-crd gap: snapshot routing is becoming server-owned (a run's residency is decided from its stored state, not a runner-provided field), so the runner-facing route is being removed rather than built into the Runner. This entry, the field, and the pod backends that set it come out together when that lands.",
    nextAttemptNumber:
      "Not a spec field: it selects the runner's name via getRunnerId, so the attempt lives in the object's name rather than in the spec runnerBodyFor builds.",
    deploymentToken:
      "Not a spec field: it is written to a per-runner Secret and referenced by name (deployment.token), so the raw token is never a value in the spec.",
    snapshotId: "Internal id; the bootstrap snapshot is identified by its friendly id.",
    runId: "Internal id; the runner is named for, and reported against, the run's friendly id.",
    version: "The deployment version is carried instead; nothing reads this alias.",
    traceContext:
      "Span context for the pod path's own emission; runnerBodyFor does not build it in.",
    dequeueResponseMs: "Producer-side timing for the wide event; not built into the Runner.",
    pollingIntervalMs: "Producer-side timing for the wide event; not built into the Runner.",
    warmStartCheckMs: "Producer-side timing for the wide event; not built into the Runner.",
  };

  /**
   * A non-baseline value per field: a built-in field changes the Runner, an ignored
   * one leaves it identical. Total over the keys, so a new option needs a probe.
   */
  const PROBES: Record<ListedKey, Partial<WorkloadManagerCreateOptions>> = {
    image: { image: `registry.example.com/other/worker:2@sha256:${"1".repeat(64)}` },
    machine: { machine: { name: "micro", cpu: 0.25, memory: 0.25, centsPerMs: 0 } },
    version: { version: "99.9.9" },
    nextAttemptNumber: { nextAttemptNumber: 5 },
    dequeuedAt: { dequeuedAt: new Date("2026-01-01T00:00:00.000Z") },
    placementTags: { placementTags: [{ key: "pool", values: ["spot"] }] },
    dequeueResponseMs: { dequeueResponseMs: 999 },
    pollingIntervalMs: { pollingIntervalMs: 999 },
    warmStartCheckMs: { warmStartCheckMs: 999 },
    envId: { envId: "env_other" },
    envType: { envType: "STAGING" },
    orgId: { orgId: "org_other" },
    projectId: { projectId: "proj_other" },
    deploymentFriendlyId: { deploymentFriendlyId: "deployment_other" },
    deploymentVersion: { deploymentVersion: "99.9.9" },
    runtime: { runtime: "bun" },
    deploymentToken: { deploymentToken: "tok_probe" },
    runId: { runId: "run_other_internal" },
    runFriendlyId: { runFriendlyId: "run_other" },
    snapshotId: { snapshotId: "snapshot_other_internal" },
    snapshotFriendlyId: { snapshotFriendlyId: "snapshot_other" },
    snapshotRoute: {
      snapshotRoute: { version: 1, residency: "redis-primary", organizationId: "org_abc" },
    },
    traceContext: { traceContext: { traceparent: "00-probe-probe-01" } },
    annotations: {
      annotations: {
        triggerSource: "schedule",
        triggerAction: "trigger",
        rootTriggerSource: "schedule",
      },
    },
    hasPrivateLink: { hasPrivateLink: true },
  };

  const excluded = new Set(Object.keys(RUN_CRD_EXCLUDED) as ListedKey[]);
  const baseline = JSON.stringify(runnerBodyFor(createOptions(), meta));

  /** True when setting the field's probe changes the Runner runnerBodyFor builds. */
  function changesRunner(field: ListedKey): boolean {
    return JSON.stringify(runnerBodyFor(createOptions(PROBES[field]), meta)) !== baseline;
  }

  it("lists every create option, so a new field cannot slip past this test", () => {
    // Fails to compile, not just at runtime, when a key is missing above.
    expect(KEYS_ARE_EXHAUSTIVE).toBe(true);
  });

  it("gives each field a probe that sets only that field", () => {
    // changesRunner reports any difference, so a probe touching a second option
    // could pass without its own field being built in.
    for (const field of CREATE_OPTION_KEYS) {
      expect(Object.keys(PROBES[field]), `PROBES.${field} must set only ${field}`).toEqual([field]);
    }
  });

  it("builds every non-excluded create option into the Runner", () => {
    const dropped = CREATE_OPTION_KEYS.filter((f) => !excluded.has(f) && !changesRunner(f));
    expect(
      dropped,
      `runnerBodyFor ignores create-options it neither builds in nor excludes: ${
        dropped.join(", ") || "(none)"
      }. Build each into the Runner, or declare it in RUN_CRD_EXCLUDED with a reason. ` +
        `Optionality is not an excuse for a silent drop.`
    ).toEqual([]);
  });

  it("excludes only options the Runner genuinely does not carry", () => {
    // An excluded field that changes the Runner means the exclusion is a lie:
    // the field is built in after all and its reason is stale.
    const carried = [...excluded].filter((f) => changesRunner(f)).sort();
    expect(
      carried,
      `RUN_CRD_EXCLUDED lists options runnerBodyFor does build in: ${carried.join(", ")}`
    ).toEqual([]);
  });
});

describe("RunCrdWorkloadManager.restore", () => {
  const checkpoint = { id: "checkpoint_abc", location: "node-a/6f1c2a9e-snap" };

  function manager(runtime: "container" | "microvm" = "microvm") {
    return new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      namespace: "v4-runs",
      runtime,
    });
  }

  beforeEach(() => {
    createRunner.mockReset();
    createRunner.mockResolvedValue({ metadata: { uid: "uid-created" } });
    getRunner.mockReset();
    deleteRunner.mockReset();
    deleteRunner.mockResolvedValue({});
    createSecret.mockReset();
    patchObject.mockReset();
    patchObject.mockResolvedValue({});
  });

  function existing(
    phase: string | undefined,
    restore = { snapshotID: "6f1c2a9e-snap", node: "node-a" }
  ) {
    return {
      metadata: { name: "runner-abc123", uid: "uid-existing" },
      spec: { restore },
      status: phase ? { phase } : undefined,
    };
  }

  it("creates a Runner named from the checkpoint that restores its location", async () => {
    await expect(manager().restore(createOptions(), checkpoint)).resolves.toEqual({
      runnerId: getRestoreRunnerId("run_abc123", "checkpoint_abc"),
      uid: "uid-created",
    });

    const { body } = createRunner.mock.calls[0]![0];
    expect(body.metadata.name).toBe(getRestoreRunnerId("run_abc123", "checkpoint_abc"));
    expect(body.spec.restore).toEqual({ snapshotID: "6f1c2a9e-snap", node: "node-a" });
  });

  // Restored anywhere else, the snapshot is not there to load.
  it("refuses a location that names no node, before creating anything", async () => {
    await expect(
      manager().restore(createOptions(), { ...checkpoint, location: "6f1c2a9e-snap" })
    ).rejects.toThrow("is not <node>/<snapshot>");
    expect(createRunner).not.toHaveBeenCalled();
  });

  it.each([undefined, "Pending", "Restoring", "Running"])(
    "leaves a resume already in the way while it is %s",
    async (phase) => {
      createRunner.mockRejectedValue({ code: 409 });
      getRunner.mockResolvedValue(existing(phase));

      await expect(manager().restore(createOptions(), checkpoint)).resolves.toEqual({
        runnerId: getRestoreRunnerId("run_abc123", "checkpoint_abc"),
        uid: "uid-existing",
      });
      expect(getRunner).toHaveBeenCalledWith(
        expect.objectContaining({ name: getRestoreRunnerId("run_abc123", "checkpoint_abc") })
      );
    }
  );

  // Held for the operator's TTL, it will never resume the guest. A Succeeded one
  // is replaced too: a redelivery means its guest exited without continuing the run.
  it.each(["Failed", "Succeeded"])(
    "replaces a resume in the way that has %s, guarded by its uid",
    async (phase) => {
      createRunner
        .mockRejectedValueOnce({ code: 409 })
        .mockResolvedValueOnce({ metadata: { uid: "uid-recreated" } });
      getRunner.mockResolvedValue(existing(phase));

      await expect(manager().restore(createOptions(), checkpoint)).resolves.toEqual({
        runnerId: getRestoreRunnerId("run_abc123", "checkpoint_abc"),
        uid: "uid-recreated",
      });
      expect(deleteRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          name: getRestoreRunnerId("run_abc123", "checkpoint_abc"),
          body: { preconditions: { uid: "uid-existing" } },
        })
      );
      expect(createRunner).toHaveBeenCalledTimes(2);
    }
  );

  // Another delivery settled it first: deleted it, or replaced it.
  it.each([404, 409])("creates again when deleting the ended resume gets a %s", async (code) => {
    createRunner
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({ metadata: { uid: "uid-recreated" } });
    getRunner.mockResolvedValue(existing("Failed"));
    deleteRunner.mockRejectedValue({ code });

    await expect(manager().restore(createOptions(), checkpoint)).resolves.toMatchObject({
      uid: "uid-recreated",
    });
  });

  it("fails when deleting the ended resume fails otherwise", async () => {
    createRunner.mockRejectedValue({ code: 409 });
    getRunner.mockResolvedValue(existing("Failed"));
    deleteRunner.mockRejectedValue({ code: 500 });

    await expect(manager().restore(createOptions(), checkpoint)).rejects.toEqual({ code: 500 });
    expect(createRunner).toHaveBeenCalledTimes(1);
  });

  it("replaces an ended resume only once per delivery", async () => {
    createRunner.mockRejectedValue({ code: 409 });
    getRunner.mockResolvedValue(existing("Failed"));

    await expect(manager().restore(createOptions(), checkpoint)).rejects.toThrow(
      "already ended (Failed)"
    );
    expect(deleteRunner).toHaveBeenCalledTimes(1);
  });

  // The collector may not have taken the deleted resume's Secret yet.
  it("gives each resume create its own token Secret", async () => {
    createSecret.mockResolvedValue({ metadata: { uid: "uid-secret" } });
    const opts = createOptions({ deploymentToken: "token-abc" });

    await manager().restore(opts, checkpoint);
    await manager().restore(opts, checkpoint);

    const [first, second] = createSecret.mock.calls.map(([req]) => req.body.metadata.name);
    expect(first).not.toEqual(second);
    expect(first).toMatch(/-token-[0-9a-f]{8}$/);
    expect(createRunner.mock.calls[0]![0].body.spec.deployment.token.name).toBe(first);
  });

  it("keeps one token Secret name per cold start, so a redrive finds it", async () => {
    createSecret.mockResolvedValue({ metadata: { uid: "uid-secret" } });
    const opts = createOptions({ deploymentToken: "token-abc" });

    await manager().create(opts);
    await manager().create(opts);

    const [first, second] = createSecret.mock.calls.map(([req]) => req.body.metadata.name);
    expect(first).toEqual(second);
  });

  it("fails when the Runner in the way restores a different snapshot", async () => {
    createRunner.mockRejectedValue({ code: 409 });
    getRunner.mockResolvedValue(
      existing("Restoring", { snapshotID: "other-snap", node: "node-a" })
    );

    await expect(manager().restore(createOptions(), checkpoint)).rejects.toThrow(
      "not node-a/6f1c2a9e-snap"
    );
  });

  it("fails when the Runner in the way cannot be read", async () => {
    createRunner.mockRejectedValue({ code: 409 });
    getRunner.mockRejectedValue({ code: 500 });

    await expect(manager().restore(createOptions(), checkpoint)).rejects.toEqual({ code: 500 });
  });

  // A requeue deletes the failed resume, and its redelivery can land in between.
  it("creates again when the Runner in the way is gone by the time it is read", async () => {
    createRunner
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({ metadata: { uid: "uid-recreated" } });
    getRunner.mockRejectedValue({ code: 404 });

    await expect(manager().restore(createOptions(), checkpoint)).resolves.toEqual({
      runnerId: getRestoreRunnerId("run_abc123", "checkpoint_abc"),
      uid: "uid-recreated",
    });
    expect(createRunner).toHaveBeenCalledTimes(2);
  });

  it("leaves a resume recreated by another delivery in between", async () => {
    createRunner.mockRejectedValue({ code: 409 });
    getRunner.mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce(existing("Pending"));

    await expect(manager().restore(createOptions(), checkpoint)).resolves.toEqual({
      runnerId: getRestoreRunnerId("run_abc123", "checkpoint_abc"),
      uid: "uid-existing",
    });
    expect(createRunner).toHaveBeenCalledTimes(2);
  });

  it("still fails a cold start that finds a Runner in the way", async () => {
    createRunner.mockRejectedValue({ code: 409 });

    await expect(manager().create(createOptions())).rejects.toEqual({ code: 409 });
  });

  it("deletes a failed resume only while it is the Runner the watch saw", async () => {
    deleteRunner.mockReset();
    deleteRunner.mockResolvedValue({});

    await manager().deleteRestoreRunner("runner-abc123", "uid-seen");

    expect(deleteRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "runner-abc123",
        namespace: "v4-runs",
        body: { preconditions: { uid: "uid-seen" } },
      })
    );
  });

  it("takes a resume already gone as deleted", async () => {
    deleteRunner.mockReset();
    deleteRunner.mockRejectedValue({ code: 404 });

    await expect(manager().deleteRestoreRunner("runner-abc123", "uid-seen")).resolves.toBe(
      undefined
    );
  });

  // 409 is the uid precondition refusing: the Runner under the name replaced ours.
  it.each([409, 500])("fails the delete on a %s", async (code) => {
    deleteRunner.mockReset();
    deleteRunner.mockRejectedValue({ code });

    await expect(manager().deleteRestoreRunner("runner-abc123", "uid-seen")).rejects.toEqual({
      code,
    });
  });

  it.each([
    ["microvm", "COMPUTE", true],
    ["microvm", "KUBERNETES", false],
    ["microvm", "DOCKER", false],
    ["container", "COMPUTE", false],
  ] as const)("on %s restores a %s checkpoint: %s", (runtime, type, expected) => {
    expect(manager(runtime).restores({ type })).toBe(expected);
  });
});

describe("RunCrdWorkloadManager.awaitRestore after the watch times out", () => {
  const timedOut = {
    ok: false as const,
    reason: "Timeout",
    error: "the Runner did not start within 10ms",
    uid: "uid-a",
  };

  function manager(result: unknown = timedOut) {
    const awaitRestore = vi.fn(async () => result);
    const m = new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      namespace: "v4-runs",
      runtime: "microvm",
      restoreInformer: { awaitRestore } as unknown as RunnerRestoreInformer,
    });
    return { m, awaitRestore };
  }

  function runnerAt(phase: string, uid = "uid-a", extra: Record<string, unknown> = {}) {
    return {
      metadata: { name: "runner-a", uid, creationTimestamp: "2026-10-01T10:00:00Z" },
      status: { phase, ...extra },
    };
  }

  beforeEach(() => {
    getRunner.mockReset();
  });

  it.each(["Running", "Suspending", "Succeeded"])(
    "counts a Runner read %s as started",
    async (phase) => {
      getRunner.mockResolvedValue(runnerAt(phase));

      await expect(
        manager().m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" })
      ).resolves.toEqual({ ok: true, createdAt: new Date("2026-10-01T10:00:00Z"), uid: "uid-a" });
    }
  );

  it("settles a Runner read Failed with the operator's reason", async () => {
    getRunner.mockResolvedValue(
      runnerAt("Failed", "uid-a", {
        conditions: [{ type: "Failed", reason: "PodStartTimeout", message: "no pod in 15m" }],
      })
    );

    await expect(
      manager().m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" })
    ).resolves.toMatchObject({ ok: false, reason: "PodStartTimeout", uid: "uid-a" });
  });

  it("stays a timeout while the Runner is still starting", async () => {
    getRunner.mockResolvedValue(runnerAt("Restoring"));

    await expect(manager().m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" })).resolves.toEqual(
      timedOut
    );
  });

  it("stays a timeout when another Runner has the name", async () => {
    getRunner.mockResolvedValue(runnerAt("Running", "uid-b"));

    await expect(manager().m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" })).resolves.toEqual(
      timedOut
    );
  });

  it.each([404, 500])("stays a timeout when the read gets a %s", async (code) => {
    getRunner.mockRejectedValue({ code });

    await expect(manager().m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" })).resolves.toEqual(
      timedOut
    );
  });

  it("reads nothing for a watch that was aborted or ended on its own", async () => {
    const abort = new AbortController();
    abort.abort();

    await manager().m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" }, undefined, abort.signal);
    await manager({ ok: true }).m.awaitRestore({ runnerId: "runner-a", uid: "uid-a" });

    expect(getRunner).not.toHaveBeenCalled();
  });
});

describe("restoreOutcome", () => {
  it.each([undefined, "Pending", "Admitted", "Scheduling", "Restoring"])(
    "is still waiting while the Runner is %s",
    (phase) => {
      expect(restoreOutcome({ status: phase ? { phase } : undefined })).toBeUndefined();
    }
  );

  it.each(["Running", "Suspending", "Succeeded"])("is a success once the Runner is %s", (phase) => {
    expect(restoreOutcome({ status: { phase } })).toEqual({ ok: true });
  });

  it("is a failure carrying the operator's reason", () => {
    const runner = {
      status: {
        phase: "Failed",
        conditions: [
          {
            type: "Failed",
            status: "True",
            reason: "StartError",
            message: "pulling the image: 401",
          },
        ],
      },
    };
    expect(restoreOutcome(runner)).toEqual({
      ok: false,
      reason: "StartError",
      error: "StartError: pulling the image: 401",
      message: "pulling the image: 401",
    });
  });

  it("is a failure even when the operator recorded no reason", () => {
    expect(restoreOutcome({ status: { phase: "Failed" } })).toEqual({
      ok: false,
      reason: "Unknown",
      error: "the Runner failed with no reason recorded",
    });
  });
});

describe("awaitRestoreOf", () => {
  /** Answers each read with the next response, repeating the last. `{ throw: err }` fails that read. */
  function reads(...responses: unknown[]) {
    const log: unknown[] = [];
    let i = 0;
    const readRunner = async () => {
      const response = responses[Math.min(i++, responses.length - 1)];
      log.push(response);
      if (response && typeof response === "object" && "throw" in response) {
        throw response.throw;
      }
      return response;
    };
    return { readRunner, log };
  }

  function awaitWith(readRunner: () => Promise<unknown>, timeoutMs = 1_000) {
    return awaitRestoreOf(readRunner, { pollMs: 1, timeoutMs, onReadError: () => {} });
  }

  it("waits through Restoring until the Runner is Running", async () => {
    const { readRunner, log } = reads(
      { status: { phase: "Pending" } },
      { status: { phase: "Restoring" } },
      { status: { phase: "Running" } }
    );

    await expect(awaitWith(readRunner)).resolves.toEqual({ ok: true });
    expect(log).toHaveLength(3);
  });

  it("reports a failed restore with the operator's reason", async () => {
    const { readRunner } = reads(
      { status: { phase: "Restoring" } },
      {
        status: {
          phase: "Failed",
          conditions: [{ type: "Failed", reason: "SnapshotNodeGone", message: "node a is gone" }],
        },
      }
    );

    await expect(awaitWith(readRunner)).resolves.toEqual({
      ok: false,
      reason: "SnapshotNodeGone",
      error: "SnapshotNodeGone: node a is gone",
      message: "node a is gone",
    });
  });

  it("waits past a Runner by the same name that is not the one it created", async () => {
    const failed = {
      metadata: { uid: "uid-old" },
      status: { phase: "Failed", conditions: [{ type: "Failed", reason: "StartError" }] },
    };
    const { readRunner, log } = reads(failed, {
      metadata: { uid: "uid-new" },
      status: { phase: "Running" },
    });

    await expect(
      awaitRestoreOf(readRunner, {
        uid: "uid-new",
        pollMs: 1,
        timeoutMs: 1_000,
        onReadError: () => {},
      })
    ).resolves.toEqual({ ok: true, uid: "uid-new" });
    expect(log).toHaveLength(2);
  });

  it("names the Runner it waited on when it times out", async () => {
    const { readRunner } = reads({ metadata: { uid: "uid-a" }, status: { phase: "Restoring" } });

    await expect(
      awaitRestoreOf(readRunner, { uid: "uid-a", pollMs: 1, timeoutMs: 20, onReadError: () => {} })
    ).resolves.toMatchObject({ ok: false, reason: "Timeout", uid: "uid-a" });
  });

  it("keeps polling through a read that may succeed next time", async () => {
    const readErrors: unknown[] = [];
    const { readRunner } = reads({ throw: { code: 500 } }, { status: { phase: "Running" } });

    await expect(
      awaitRestoreOf(readRunner, {
        pollMs: 1,
        timeoutMs: 1_000,
        onReadError: (err) => readErrors.push(err),
      })
    ).resolves.toEqual({ ok: true });
    expect(readErrors).toEqual([{ code: 500 }]);
  });

  it("fails when the Runner is gone", async () => {
    const { readRunner } = reads({ throw: { code: 404 } });

    await expect(awaitWith(readRunner)).resolves.toEqual({
      ok: false,
      reason: "RunnerGone",
      error: "the Runner no longer exists",
    });
  });

  it("stops polling once aborted", async () => {
    const abort = new AbortController();
    const read = vi.fn(async () => ({
      metadata: { uid: "uid-a" },
      status: { phase: "Restoring" },
    }));
    const outcome = awaitRestoreOf(read, {
      uid: "uid-a",
      pollMs: 60_000,
      timeoutMs: 600_000,
      signal: abort.signal,
      onReadError: () => {},
    });

    abort.abort();

    await expect(outcome).resolves.toMatchObject({ ok: false, reason: "Timeout" });
    expect(read).not.toHaveBeenCalled();
  });

  it("gives up after its timeout", async () => {
    const { readRunner } = reads({ status: { phase: "Restoring" } });

    await expect(awaitWith(readRunner, 20)).resolves.toEqual({
      ok: false,
      reason: "Timeout",
      error: "the Runner did not start within 20ms",
    });
  });

  it("reports each phase it reads and when the Runner was created", async () => {
    const phases: unknown[] = [];
    const { readRunner } = reads(
      { status: { phase: "Scheduling" } },
      {
        metadata: { creationTimestamp: "2026-10-01T10:00:00Z" },
        status: { phase: "Running" },
      }
    );

    await expect(
      awaitRestoreOf(readRunner, {
        pollMs: 1,
        timeoutMs: 1_000,
        onPhase: (phase) => phases.push(phase),
        onReadError: () => {},
      })
    ).resolves.toEqual({ ok: true, createdAt: new Date("2026-10-01T10:00:00Z") });
    expect(phases).toEqual(["Scheduling", "Running"]);
  });

  it("doubles the wait after each 429 or 5xx in a row", async () => {
    const at: number[] = [];
    const responses = [{ code: 429 }, { code: 503 }];
    const readRunner = async () => {
      at.push(Date.now());
      const err = responses.shift();
      if (err) {
        throw err;
      }
      return { status: { phase: "Running" } };
    };

    await expect(
      awaitRestoreOf(readRunner, { pollMs: 20, timeoutMs: 5_000, onReadError: () => {} })
    ).resolves.toEqual({ ok: true });
    // Timers can fire a millisecond early, never late enough to matter here.
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(39);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(79);
  });
});

describe("pollDelayMs", () => {
  const far = () => Date.now() + 10 * 60_000;

  it("is the poll interval until the API server sheds or fails a read", () => {
    expect(pollDelayMs(5_000, 0, far())).toBe(5_000);
  });

  it("doubles per overloaded read and stops at a minute", () => {
    expect(pollDelayMs(5_000, 1, far())).toBe(10_000);
    expect(pollDelayMs(5_000, 3, far())).toBe(40_000);
    expect(pollDelayMs(5_000, 10, far())).toBe(60_000);
  });

  it("never waits past the deadline", () => {
    const delay = pollDelayMs(5_000, 3, Date.now() + 1_000);
    expect(delay).toBeLessThanOrEqual(1_000);
    expect(pollDelayMs(5_000, 0, Date.now() - 1)).toBe(0);
  });
});

describe("RunnerRestoreInformer", () => {
  function fakeInformer() {
    const handlers: Record<string, Array<(obj: unknown) => void>> = {};
    const cache = new Map<string, unknown>();
    return {
      cache,
      on: (verb: string, fn: (obj: unknown) => void) => (handlers[verb] ??= []).push(fn),
      off: () => {},
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      get: (name: string) => cache.get(name),
      list: () => [...cache.values()],
      emit: (verb: string, obj: unknown) => handlers[verb]?.forEach((fn) => fn(obj)),
    };
  }

  function setup() {
    const informer = fakeInformer();
    const makeInformer = vi.fn(() => informer);
    const unwatched: unknown[] = [];
    const adopted: unknown[] = [];
    const restoreInformer = new RunnerRestoreInformer({
      namespace: "v4-runs",
      k8s: {
        makeInformer,
        custom: { listNamespacedCustomObject: listRunners },
      } as unknown as K8sApi,
      onUnwatchedFailure: (failure) => unwatched.push(failure),
      onUnwatchedRestore: (restore) => adopted.push(restore),
    });
    const list = (makeInformer.mock.calls[0] as unknown as [string, () => Promise<unknown>])[1];
    return { informer, makeInformer, restoreInformer, unwatched, adopted, list };
  }

  type WatchCall = {
    query: Record<string, string>;
    callback: (phase: string, obj: unknown) => void;
    done: (err: unknown) => void;
  };

  /** The client's own ListWatch over a fake Watch, which can fail to connect as the real one does. */
  function listWatchSetup(connects: Array<"ok" | "fail"> = []) {
    const calls: WatchCall[] = [];
    const watch = {
      watch: vi.fn(
        async (
          _path: string,
          query: Record<string, string>,
          callback: WatchCall["callback"],
          done: WatchCall["done"]
        ) => {
          calls.push({ query, callback, done });
          // The real Watch calls done with its fetch error before returning.
          if (connects.shift() === "fail") {
            done(new Error("connect ECONNREFUSED"));
          }
          return { abort: () => {} };
        }
      ),
    };
    const restoreInformer = new RunnerRestoreInformer({
      namespace: "v4-runs",
      reconnectIntervalMs: 1,
      k8s: {
        makeInformer: (path: string, listFn: ListPromise<KubernetesObject>, selector?: string) =>
          new ListWatch(path, watch as unknown as Watch, listFn, false, selector),
        custom: { listNamespacedCustomObject: listRunners },
      } as unknown as K8sApi,
    });
    return { calls, restoreInformer };
  }

  function runner(
    name: string,
    phase?: string,
    extra: Record<string, unknown> = {},
    uid = `uid-${name}`
  ) {
    return {
      metadata: { name, namespace: "v4-runs", uid, creationTimestamp: "2026-10-01T10:00:00Z" },
      status: phase ? { phase, ...extra } : undefined,
    };
  }

  const failed = (name: string) =>
    runner(name, "Failed", {
      conditions: [{ type: "Failed", reason: "SnapshotNodeGone", message: "node a is gone" }],
    });

  it("watches only labelled restore Runners", async () => {
    const { makeInformer } = setup();

    expect(makeInformer).toHaveBeenCalledWith(
      "/apis/compute.trigger.dev/v1alpha1/namespaces/v4-runs/runners",
      expect.any(Function),
      `${RESTORE_LABEL}=true`
    );
    listRunners.mockReset();
    listRunners.mockResolvedValue({ items: [], metadata: {} });
    await (makeInformer.mock.calls[0] as unknown as [string, () => Promise<unknown>])[1]();
    expect(listRunners).toHaveBeenCalledWith(
      expect.objectContaining({ labelSelector: `${RESTORE_LABEL}=true` })
    );
  });

  it("resolves when the Runner's phase moves to Running, ignoring other Runners", async () => {
    const { informer, restoreInformer } = setup();
    const phases: unknown[] = [];
    let settled = false;
    const outcome = restoreInformer
      .awaitRestore("runner-a", { timeoutMs: 60_000, onPhase: (phase) => phases.push(phase) })
      .finally(() => (settled = true));

    informer.emit("add", runner("runner-a", "Pending"));
    informer.emit("update", runner("runner-b", "Running"));
    informer.emit("update", runner("runner-a", "Restoring"));
    await Promise.resolve();
    expect(settled).toBe(false);
    informer.emit("update", runner("runner-a", "Running"));

    await expect(outcome).resolves.toEqual({
      ok: true,
      createdAt: new Date("2026-10-01T10:00:00Z"),
      uid: "uid-runner-a",
    });
    expect(phases).toEqual(["Pending", "Restoring", "Running"]);
  });

  it("resolves a failure with the operator's reason", async () => {
    const { informer, restoreInformer } = setup();
    const outcome = restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });

    informer.emit("update", failed("runner-a"));

    await expect(outcome).resolves.toMatchObject({ ok: false, reason: "SnapshotNodeGone" });
  });

  it("resolves when the Runner is deleted before it starts", async () => {
    const { informer, restoreInformer } = setup();
    const outcome = restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });

    informer.emit("delete", runner("runner-a", "Restoring"));

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "RunnerGone",
      error: "the Runner no longer exists",
    });
  });

  it("resolves from the cache when the Runner's events came before the waiter", async () => {
    const { informer, restoreInformer } = setup();
    informer.cache.set("runner-a", failed("runner-a"));

    await expect(
      restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 })
    ).resolves.toMatchObject({ ok: false, reason: "SnapshotNodeGone" });
  });

  it("ignores a cached or replaced Runner by the same name that it did not create", async () => {
    const { informer, restoreInformer } = setup();
    informer.cache.set("runner-a", runner("runner-a", "Failed", {}, "uid-old"));
    let settled = false;
    const outcome = restoreInformer
      .awaitRestore("runner-a", { uid: "uid-new", timeoutMs: 60_000 })
      .finally(() => (settled = true));

    informer.emit("update", runner("runner-a", "Failed", {}, "uid-old"));
    informer.emit("delete", runner("runner-a", "Failed", {}, "uid-old"));
    await Promise.resolve();
    expect(settled).toBe(false);
    informer.emit("add", runner("runner-a", "Running", {}, "uid-new"));

    await expect(outcome).resolves.toMatchObject({ ok: true, uid: "uid-new" });
  });

  it("gives up after its timeout", async () => {
    const { restoreInformer } = setup();

    await expect(restoreInformer.awaitRestore("runner-a", { timeoutMs: 10 })).resolves.toEqual({
      ok: false,
      reason: "Timeout",
      error: "the Runner did not start within 10ms",
    });
  });

  it("shares one wait between callers for the same Runner", async () => {
    const { informer, restoreInformer } = setup();
    const first = restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });
    const second = restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });

    informer.emit("update", runner("runner-a", "Running"));

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("surfaces a restore listed already failed with nothing waiting on it", () => {
    const { informer, unwatched } = setup();
    const bootstrap = { runFriendlyID: "run_abc", snapshotFriendlyID: "snapshot_abc" };

    informer.emit("add", runner("runner-live", "Running"));
    informer.emit("update", failed("runner-updated"));
    informer.emit("add", { ...failed("runner-a"), spec: { bootstrap } });

    expect(unwatched).toEqual([
      {
        runnerId: "runner-a",
        runFriendlyId: "run_abc",
        snapshotFriendlyId: "snapshot_abc",
        outcome: expect.objectContaining({
          ok: false,
          reason: "SnapshotNodeGone",
          uid: "uid-runner-a",
        }),
      },
    ]);
  });

  it("gets a restore listed already failed reported against its bootstrap snapshot", async () => {
    const informer = fakeInformer();
    const report = vi.fn(async () => ({ success: true as const }));
    const deleted: unknown[] = [];
    const settled: Promise<unknown>[] = [];
    new RunnerRestoreInformer({
      namespace: "v4-runs",
      k8s: {
        makeInformer: () => informer,
        custom: { listNamespacedCustomObject: listRunners },
      } as unknown as K8sApi,
      onUnwatchedFailure: ({ runnerId, outcome }) =>
        void settled.push(
          settleRestoreFailure(
            { runnerId, outcome },
            { deleteRunner: async (...args) => void deleted.push(args), report }
          )
        ),
    });
    const bootstrap = { runFriendlyID: "run_abc", snapshotFriendlyID: "snapshot_abc" };

    informer.emit("add", {
      ...runner("runner-a", "Failed", {
        conditions: [{ type: "Failed", reason: "PodStartTimeout", message: "no pod in 15m" }],
      }),
      spec: { bootstrap },
    });
    await Promise.all(settled);

    expect(deleted).toEqual([["runner-a", "uid-runner-a"]]);
    expect(report).toHaveBeenCalledWith({
      outcome: "requeue",
      reason: "PodStartTimeout",
      message: "no pod in 15m",
    });
  });

  it("watches a restore the first list found still starting, once", async () => {
    const { informer, adopted, list } = setup();
    const bootstrap = { runFriendlyID: "run_abc", snapshotFriendlyID: "snapshot_abc" };
    const listed = { ...runner("runner-a", "Restoring"), spec: { bootstrap } };
    listRunners.mockReset();
    listRunners.mockResolvedValue({ items: [listed], metadata: {} });

    await list();
    informer.emit("add", listed);
    informer.emit("add", listed);
    // Created after the first list, so whoever created it watches it.
    informer.emit("add", runner("runner-b", "Pending"));
    await list();
    informer.emit("add", { ...runner("runner-c", "Restoring"), spec: { bootstrap } });

    expect(adopted).toEqual([
      {
        runnerId: "runner-a",
        uid: "uid-runner-a",
        runFriendlyId: "run_abc",
        snapshotFriendlyId: "snapshot_abc",
      },
    ]);
  });

  it("does not take over a listed restore something here already waits on", async () => {
    const { informer, restoreInformer, adopted, list } = setup();
    listRunners.mockReset();
    listRunners.mockResolvedValue({ items: [runner("runner-a", "Restoring")], metadata: {} });
    void restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });

    await list();
    informer.emit("add", runner("runner-a", "Restoring"));

    expect(adopted).toEqual([]);
  });

  it("keeps a separate wait for each Runner by the same name", async () => {
    const { informer, restoreInformer } = setup();
    let oldSettled = false;
    void restoreInformer
      .awaitRestore("runner-a", { uid: "uid-old", timeoutMs: 60_000 })
      .finally(() => (oldSettled = true));
    const fresh = restoreInformer.awaitRestore("runner-a", { uid: "uid-new", timeoutMs: 60_000 });

    informer.emit("add", runner("runner-a", "Running", {}, "uid-new"));

    await expect(fresh).resolves.toMatchObject({ ok: true, uid: "uid-new" });
    expect(oldSettled).toBe(false);
  });

  it("ends an aborted wait as a timeout, leaving others", async () => {
    const { informer, restoreInformer } = setup();
    const abort = new AbortController();
    const aborted = restoreInformer.awaitRestore("runner-a", {
      uid: "uid-old",
      timeoutMs: 60_000,
      signal: abort.signal,
    });
    const other = restoreInformer.awaitRestore("runner-a", { uid: "uid-new", timeoutMs: 60_000 });

    abort.abort();
    informer.emit("update", runner("runner-a", "Running", {}, "uid-new"));

    await expect(aborted).resolves.toMatchObject({ ok: false, reason: "Timeout" });
    await expect(other).resolves.toMatchObject({ ok: true });
  });

  it("keeps reconnecting while the watch fails to connect", async () => {
    listRunners.mockReset();
    listRunners.mockResolvedValue({ items: [], metadata: { resourceVersion: "1" } });
    const { calls, restoreInformer } = listWatchSetup(["ok", "fail", "fail", "ok"]);
    await restoreInformer.start();
    const outcome = restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });

    calls[0]!.done(new Error("stream reset"));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3]!.callback("ADDED", runner("runner-a", "Running"));

    await expect(outcome).resolves.toMatchObject({ ok: true });
    await restoreInformer.stop();
  });

  it("reconnects after a failed relist without dropping its cached Runners", async () => {
    listRunners.mockReset();
    listRunners
      .mockResolvedValueOnce({
        items: [runner("runner-a", "Restoring")],
        metadata: { resourceVersion: "1" },
      })
      .mockRejectedValueOnce({ code: 503 })
      .mockResolvedValue({
        items: [runner("runner-a", "Restoring")],
        metadata: { resourceVersion: "9" },
      });
    const { calls, restoreInformer } = listWatchSetup();
    await restoreInformer.start();
    const outcome = restoreInformer.awaitRestore("runner-a", { timeoutMs: 60_000 });

    // A 410 in the stream, then the close: the client relists on its own.
    calls[0]!.callback("ERROR", { code: 410 });
    calls[0]!.done(null);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.callback("MODIFIED", {
      ...runner("runner-a", "Running"),
      metadata: { ...runner("runner-a").metadata, resourceVersion: "10" },
    });

    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(listRunners).toHaveBeenCalledTimes(3);
    expect(calls[1]!.query.resourceVersion).toBe("9");
    await restoreInformer.stop();
  });

  // Otherwise a reconnect replays every event since the list.
  it("resumes the watch from the last event it saw", async () => {
    listRunners.mockReset();
    listRunners.mockResolvedValue({ items: [], metadata: { resourceVersion: "1" } });
    const { calls, restoreInformer } = listWatchSetup();
    await restoreInformer.start();

    calls[0]!.callback("ADDED", {
      ...runner("runner-a", "Pending"),
      metadata: { ...runner("runner-a").metadata, resourceVersion: "5" },
    });
    calls[0]!.callback("BOOKMARK", { metadata: { resourceVersion: "7" } });
    calls[0]!.done(null);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1]!.query.resourceVersion).toBe("7");
    await restoreInformer.stop();
  });
});

describe("classifyRestoreFailure", () => {
  it.each([
    ["SnapshotNodeGone", { outcome: "fail" }],
    ["SnapshotNodeUnschedulable", { outcome: "fail" }],
    ["RestoreNotSupported", { outcome: "fail" }],
    ["SnapshotNotFound", { outcome: "fail" }],
    ["PodStartTimeout", { outcome: "requeue", deleteRunner: true }],
    ["StartError", { outcome: "requeue", deleteRunner: true }],
    ["ContainerFailed", { outcome: "requeue", deleteRunner: true }],
    ["PodFailed", { outcome: "requeue", deleteRunner: true }],
    ["Unknown", { outcome: "requeue", deleteRunner: true }],
    ["SomethingNew", { outcome: "requeue", deleteRunner: true }],
    ["Timeout", undefined],
    ["RunnerGone", { outcome: "requeue", deleteRunner: false }],
    ["ReadFailed", undefined],
  ])("%s -> %j", (reason, expected) => {
    expect(classifyRestoreFailure(reason)).toEqual(expected);
  });
});

describe("settleRestoreFailure", () => {
  function failure(reason: string, uid: string | null = "uid-a", message?: string) {
    return {
      runnerId: "runner-a",
      outcome: {
        ok: false as const,
        reason,
        error: `${reason}: ${message ?? "detail"}`,
        ...(message ? { message } : {}),
        uid: uid ?? undefined,
      },
    };
  }

  function deps(
    opts: {
      deleteError?: unknown;
      report?: { success: true } | { success: false; error: string; statusCode?: number };
    } = {}
  ) {
    const calls: string[] = [];
    const deleteRunner = vi.fn(async (_runnerId: string, _uid: string) => {
      calls.push("delete");
      if (opts.deleteError) {
        throw opts.deleteError;
      }
    });
    const report = vi.fn(async (_body: unknown) => {
      calls.push("report");
      return opts.report ?? { success: true as const };
    });
    return { calls, deleteRunner, report };
  }

  it("deletes the Runner it saw, then requeues", async () => {
    const d = deps();

    await expect(
      settleRestoreFailure(failure("StartError", "uid-a", "pulling the image: 401"), d)
    ).resolves.toEqual({ action: "reported", outcome: "requeue", result: "ok" });
    expect(d.calls).toEqual(["delete", "report"]);
    expect(d.deleteRunner).toHaveBeenCalledWith("runner-a", "uid-a");
    expect(d.report).toHaveBeenCalledWith({
      outcome: "requeue",
      reason: "StartError",
      message: "pulling the image: 401",
    });
  });

  it("sends the dequeued run's snapshot route with the report", async () => {
    const d = deps();
    const snapshotRoute = {
      version: 1 as const,
      residency: "mirrored" as const,
      organizationId: "org_1",
    };

    await settleRestoreFailure({ ...failure("SnapshotNodeGone"), snapshotRoute }, d);

    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "fail", snapshotRoute })
    );
  });

  // The Runner may be running a guest the watch never saw start.
  it("neither deletes nor reports a Runner the watch timed out on", async () => {
    const d = deps();

    await expect(settleRestoreFailure(failure("Timeout"), d)).resolves.toEqual({
      action: "none",
    });
    expect(d.calls).toEqual([]);
  });

  it("requeues a Runner already gone without deleting anything", async () => {
    const d = deps();

    await settleRestoreFailure(failure("RunnerGone", null), d);

    expect(d.calls).toEqual(["report"]);
  });

  it("does not requeue when the delete fails, since the redelivery would hit the held Runner", async () => {
    const d = deps({ deleteError: { code: 409, message: "uid precondition failed" } });

    await expect(settleRestoreFailure(failure("PodStartTimeout"), d)).resolves.toMatchObject({
      action: "kept",
    });
    expect(d.report).not.toHaveBeenCalled();
  });

  // A role without delete on runners leaves the run to the stall timeout, as before restores were reported.
  it("does not requeue when the delete is forbidden, and says so", async () => {
    const d = deps({
      deleteError: Object.assign(new Error("runners is forbidden"), { code: 403 }),
    });

    await expect(settleRestoreFailure(failure("PodStartTimeout"), d)).resolves.toEqual({
      action: "kept",
      error: "runners is forbidden",
      forbidden: true,
    });
    expect(d.report).not.toHaveBeenCalled();
  });

  it("does not requeue without a uid to guard the delete", async () => {
    const d = deps();

    await expect(settleRestoreFailure(failure("PodStartTimeout", null), d)).resolves.toMatchObject({
      action: "kept",
    });
    expect(d.calls).toEqual([]);
  });

  it("fails a restore that cannot go ahead with the operator's message, then deletes the Runner", async () => {
    const d = deps();

    await expect(
      settleRestoreFailure(failure("SnapshotNodeGone", "uid-a", "node a is gone"), d)
    ).resolves.toEqual({ action: "reported", outcome: "fail", result: "ok" });
    expect(d.calls).toEqual(["report", "delete"]);
    expect(d.deleteRunner).toHaveBeenCalledWith("runner-a", "uid-a");
    expect(d.report).toHaveBeenCalledWith({
      outcome: "fail",
      reason: "SnapshotNodeGone",
      message: "node a is gone",
    });
  });

  it("reports nothing when the Runner could not be read", async () => {
    const d = deps();

    await expect(settleRestoreFailure(failure("ReadFailed"), d)).resolves.toEqual({
      action: "none",
    });
    expect(d.calls).toEqual([]);
  });

  it("takes a 409 as the run having moved on", async () => {
    const d = deps({ report: { success: false, error: "conflict", statusCode: 409 } });

    await expect(settleRestoreFailure(failure("SnapshotNodeGone"), d)).resolves.toEqual({
      action: "reported",
      outcome: "fail",
      result: "conflict",
      error: "conflict",
    });
    expect(d.report).toHaveBeenCalledTimes(1);
    expect(d.calls).toEqual(["report", "delete"]);
  });

  // Kept, so the next supervisor to list it tries the report again.
  it("keeps a failed Runner whose fail report did not land", async () => {
    const d = deps({ report: { success: false, error: "unavailable", statusCode: 503 } });

    await settleRestoreFailure(failure("SnapshotNotFound"), d);

    expect(d.calls).toEqual(["report"]);
  });

  it("returns a failed cleanup delete with the report it followed", async () => {
    const d = deps({ deleteError: { code: 500, message: "etcd timeout" } });

    await expect(settleRestoreFailure(failure("SnapshotNodeGone"), d)).resolves.toMatchObject({
      action: "reported",
      outcome: "fail",
      result: "ok",
      cleanupError: expect.any(String),
    });
  });

  it("returns any other report failure as an error", async () => {
    const d = deps({ report: { success: false, error: "unavailable", statusCode: 503 } });

    await expect(settleRestoreFailure(failure("StartError"), d)).resolves.toMatchObject({
      action: "reported",
      outcome: "requeue",
      result: "error",
    });
  });
});

describe("restoreHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("beats while the Runner is starting and stops once it runs", async () => {
    const beat = vi.fn(async () => {});
    const heartbeat = restoreHeartbeat(beat, 10);

    heartbeat.onPhase("Scheduling");
    await vi.advanceTimersByTimeAsync(20);
    expect(beat).toHaveBeenCalledTimes(2);

    // The same beat carries on through Restoring rather than starting over.
    await vi.advanceTimersByTimeAsync(5);
    heartbeat.onPhase("Restoring");
    await vi.advanceTimersByTimeAsync(5);
    expect(beat).toHaveBeenCalledTimes(3);

    heartbeat.onPhase("Running");
    await vi.advanceTimersByTimeAsync(100);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  // Reads failing past the platform's stall timeout must not requeue a healthy restore.
  it("beats before any phase is read", async () => {
    const beat = vi.fn(async () => {});
    const heartbeat = restoreHeartbeat(beat, 10);

    await vi.advanceTimersByTimeAsync(25);
    expect(beat).toHaveBeenCalledTimes(2);

    heartbeat.onPhase(undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(beat).toHaveBeenCalledTimes(3);
    heartbeat.stop();
  });

  // Admitted covers the operator retrying a pod create for up to five minutes.
  it.each(["Pending", "Admitted", "Scheduling", "Restoring"])(
    "beats while the Runner is %s",
    async (phase) => {
      const beat = vi.fn(async () => {});
      const heartbeat = restoreHeartbeat(beat, 10);

      heartbeat.onPhase(phase);
      await vi.advanceTimersByTimeAsync(25);
      expect(beat).toHaveBeenCalledTimes(2);
      heartbeat.stop();
    }
  );

  it.each(["Failed", "Succeeded"])("stops when the Runner ends %s", async (phase) => {
    const beat = vi.fn(async () => {});
    const heartbeat = restoreHeartbeat(beat, 10);

    heartbeat.onPhase("Restoring");
    heartbeat.onPhase(phase);
    await vi.advanceTimersByTimeAsync(100);
    expect(beat).not.toHaveBeenCalled();
  });

  it("stops when the watch ends", async () => {
    const beat = vi.fn(async () => {});
    const heartbeat = restoreHeartbeat(beat, 10);

    heartbeat.onPhase("Restoring");
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(beat).not.toHaveBeenCalled();
  });
});

describe("RunCrdWorkloadManager.suspend", () => {
  function manager(snapshots = { enabled: true, delayMs: 5_000, dispatchLimit: 10 }) {
    return new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      namespace: "v4-runs",
      runtime: "microvm",
      snapshots,
      suspendPollMs: 1,
      suspendTimeoutMs: 200,
    });
  }

  function runner(status: Record<string, unknown>) {
    return { metadata: { name: "runner-abc123" }, status };
  }

  const taken = runner({
    phase: "Suspending",
    suspend: { request: "snapshot_abc", snapshotID: "snap-1", node: "node-a" },
    conditions: [{ type: "Suspended", status: "True", reason: "SnapshotTaken", message: "m" }],
  });

  beforeEach(() => {
    getRunner.mockReset();
    patchObject.mockReset();
    patchObject.mockResolvedValue({});
  });

  const target = {
    runnerId: "runner-abc123",
    runFriendlyId: "run_abc",
    snapshotFriendlyId: "snapshot_abc",
  };
  const owner = { envId: "env_1", deploymentFriendlyId: "deployment_1" };
  const owned = {
    metadata: { name: "runner-abc123" },
    spec: { owner: { envID: "env_1" }, deployment: { friendlyID: "deployment_1" } },
  };

  it("asks on the Runner's annotation, named by the snapshot", async () => {
    await expect(manager().requestSuspend(target)).resolves.toEqual({ ok: true });

    const [object, , , , , strategy] = patchObject.mock.calls[0]!;
    expect(object).toEqual({
      apiVersion: "compute.trigger.dev/v1alpha1",
      kind: "Runner",
      metadata: {
        name: "runner-abc123",
        namespace: "v4-runs",
        annotations: { [SUSPEND_ANNOTATION]: "snapshot_abc", [SUSPEND_RUN_ANNOTATION]: "run_abc" },
      },
    });
    expect(strategy).toBe("application/merge-patch+json");
    expect(getRunner).not.toHaveBeenCalled();
  });

  it("marks a request submitted on the Runner's annotation", async () => {
    await manager().markSuspendSubmitted(target);

    const [object, , , , , strategy] = patchObject.mock.calls[0]!;
    expect(object.metadata).toEqual({
      name: "runner-abc123",
      namespace: "v4-runs",
      annotations: { [SUSPEND_SUBMITTED_ANNOTATION]: "snapshot_abc" },
    });
    expect(strategy).toBe("application/merge-patch+json");
  });

  it("reads one Runner's answered suspend not yet submitted", async () => {
    const annotations = {
      [SUSPEND_ANNOTATION]: "snapshot_abc",
      [SUSPEND_RUN_ANNOTATION]: "run_abc",
    };
    getRunner.mockResolvedValue({ ...taken, metadata: { name: "runner-abc123", annotations } });

    await expect(manager().publishedSuspendOf("runner-abc123")).resolves.toMatchObject({
      snapshotFriendlyId: "snapshot_abc",
      outcome: { ok: true, location: "node-a/snap-1" },
    });
  });

  it("lists the answered suspends not yet submitted", async () => {
    const annotations = {
      [SUSPEND_ANNOTATION]: "snapshot_abc",
      [SUSPEND_RUN_ANNOTATION]: "run_abc",
    };
    listRunners.mockResolvedValue({
      items: [
        { ...taken, metadata: { name: "runner-abc123", annotations } },
        { metadata: { name: "runner-idle" }, status: { phase: "Running" } },
      ],
    });

    await expect(manager().publishedSuspends()).resolves.toEqual([
      {
        runnerId: "runner-abc123",
        runFriendlyId: "run_abc",
        snapshotFriendlyId: "snapshot_abc",
        outcome: { ok: true, location: "node-a/snap-1" },
      },
    ]);
    expect(listRunners).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "v4-runs", plural: "runners" })
    );
  });

  it("annotates a Runner the caller's deployment owns", async () => {
    getRunner.mockResolvedValue(owned);

    await expect(manager().requestSuspend({ ...target, owner })).resolves.toEqual({ ok: true });
    expect(patchObject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["environment", { ...owner, envId: "env_2" }],
    ["deployment", { ...owner, deploymentFriendlyId: "deployment_2" }],
  ])("refuses a Runner from another %s", async (_what, caller) => {
    getRunner.mockResolvedValue(owned);

    await expect(manager().requestSuspend({ ...target, owner: caller })).resolves.toEqual({
      ok: false,
      error: "the Runner belongs to another deployment",
    });
    expect(patchObject).not.toHaveBeenCalled();
  });

  it("fails when the request cannot be made", async () => {
    patchObject.mockRejectedValue(new Error("forbidden"));

    await expect(manager().requestSuspend(target)).resolves.toEqual({
      ok: false,
      error: "suspend request failed: forbidden",
    });
  });

  it("waits for the operator's answer and returns the snapshot", async () => {
    getRunner
      .mockResolvedValueOnce(runner({ phase: "Running" }))
      .mockRejectedValueOnce({ code: 500 })
      .mockResolvedValueOnce(
        runner({
          phase: "Suspending",
          suspend: { request: "snapshot_abc" },
          conditions: [{ type: "Suspended", status: "Unknown", reason: "SnapshotRequested" }],
        })
      )
      .mockResolvedValue(taken);

    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: true,
      location: "node-a/snap-1",
    });
    expect(getRunner).toHaveBeenCalledTimes(4);
  });

  it("fails when the Runner is gone", async () => {
    getRunner.mockRejectedValue({ code: 404 });
    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: false,
      error: "the Runner no longer exists",
    });
  });

  it.each([400, 401, 403, 422])("gives up on a %i reading the Runner", async (code) => {
    getRunner.mockRejectedValue(Object.assign(new Error(`HTTP ${code}`), { code }));
    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: false,
      error: `Runner read failed: HTTP ${code}`,
    });
    expect(getRunner).toHaveBeenCalledTimes(1);
  });

  it("says so when no operator takes the request up", async () => {
    getRunner.mockResolvedValue(runner({ phase: "Running" }));
    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: false,
      error:
        "the operator did not take up the suspend within 200ms; is a suspend-capable operator running?",
    });
  });

  it("restarts the wait once the operator takes the request up", async () => {
    const pending = runner({
      phase: "Suspending",
      suspend: { request: "snapshot_abc" },
      conditions: [{ type: "Suspended", status: "Unknown", reason: "SnapshotRequested" }],
    });
    const start = Date.now();
    getRunner.mockImplementation(async () =>
      Date.now() - start < 150 ? runner({ phase: "Running" }) : pending
    );

    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: false,
      error: "no suspend outcome within 200ms of the operator taking it up",
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(350);
  });

  it("fails once a later request displaces one the operator took up", async () => {
    const answering = (request: string) =>
      runner({
        phase: "Suspending",
        suspend: { request },
        conditions: [{ type: "Suspended", status: "Unknown", reason: "SnapshotRequested" }],
      });
    getRunner
      .mockResolvedValueOnce(answering("snapshot_abc"))
      .mockResolvedValue(answering("snapshot_later"));

    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: false,
      error: "displaced by a later suspend request",
    });
    expect(getRunner).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting behind an earlier request not yet answered", async () => {
    getRunner
      .mockResolvedValueOnce(
        runner({ phase: "Suspending", suspend: { request: "snapshot_older" } })
      )
      .mockResolvedValue(taken);

    await expect(manager().awaitSuspend(target)).resolves.toEqual({
      ok: true,
      location: "node-a/snap-1",
    });
  });

  it("is enabled only under microvm with snapshots on", () => {
    expect(manager().snapshotsEnabled).toBe(true);
    expect(manager({ enabled: false, delayMs: 0, dispatchLimit: 1 }).snapshotsEnabled).toBe(false);
    const container = new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      namespace: "v4-runs",
      runtime: "container",
      snapshots: { enabled: true, delayMs: 0, dispatchLimit: 1 },
    });
    expect(container.snapshotsEnabled).toBe(false);
  });
});

describe("suspendOutcome", () => {
  const request = "snapshot_abc";

  it("waits while the operator has not answered this request", () => {
    expect(suspendOutcome({ status: { phase: "Running" } }, request)).toBeUndefined();
    expect(
      suspendOutcome(
        {
          status: {
            phase: "Suspending",
            suspend: { request: "snapshot_older", snapshotID: "snap-0" },
            conditions: [{ type: "Suspended", status: "True" }],
          },
        },
        request
      )
    ).toBeUndefined();
  });

  it("reports a failed or refused suspend with its reason", () => {
    const outcome = suspendOutcome(
      {
        status: {
          phase: "Running",
          suspend: { request },
          conditions: [
            { type: "Suspended", status: "False", reason: "SnapshotFailed", message: "boom" },
          ],
        },
      },
      request
    );
    expect(outcome).toEqual({ ok: false, error: "SnapshotFailed: boom" });
  });

  it("waits for the node as well as the snapshot id", () => {
    const answered = (suspend: Record<string, string>) =>
      suspendOutcome(
        {
          status: {
            phase: "Suspending",
            suspend: { request, ...suspend },
            conditions: [{ type: "Suspended", status: "True" }],
          },
        },
        request
      );
    expect(answered({ snapshotID: "snap-1" })).toBeUndefined();
    expect(answered({ snapshotID: "snap-1", node: "node-a" })).toEqual({
      ok: true,
      location: "node-a/snap-1",
    });
  });

  it("gives up on a Runner that ended without answering", () => {
    expect(suspendOutcome({ status: { phase: "Failed" } }, request)).toMatchObject({ ok: false });
  });
});

describe("publishedSuspend", () => {
  const status = {
    phase: "Suspending",
    suspend: { request: "snapshot_abc", snapshotID: "snap-1", node: "node-a" },
    conditions: [{ type: "Suspended", status: "True" }],
  };
  const runner = (annotations: Record<string, string>, s: Record<string, unknown> = status) => ({
    metadata: { name: "runner-abc123", annotations },
    status: s,
  });
  const requested = { [SUSPEND_ANNOTATION]: "snapshot_abc", [SUSPEND_RUN_ANNOTATION]: "run_abc" };

  it("returns an answered request the platform has not accepted", () => {
    expect(publishedSuspend(runner(requested))).toEqual({
      runnerId: "runner-abc123",
      runFriendlyId: "run_abc",
      snapshotFriendlyId: "snapshot_abc",
      outcome: { ok: true, location: "node-a/snap-1" },
    });
  });

  it("returns a failed answer too, so the platform stops waiting", () => {
    const failed = {
      phase: "Running",
      suspend: { request: "snapshot_abc" },
      conditions: [
        { type: "Suspended", status: "False", reason: "SnapshotFailed", message: "boom" },
      ],
    };
    expect(publishedSuspend(runner(requested, failed))?.outcome).toEqual({
      ok: false,
      error: "SnapshotFailed: boom",
    });
  });

  it("skips a request already submitted", () => {
    expect(
      publishedSuspend(runner({ ...requested, [SUSPEND_SUBMITTED_ANNOTATION]: "snapshot_abc" }))
    ).toBeUndefined();
  });

  it("returns a newer request when only an older one was submitted", () => {
    expect(
      publishedSuspend(runner({ ...requested, [SUSPEND_SUBMITTED_ANNOTATION]: "snapshot_older" }))
    ).toMatchObject({ snapshotFriendlyId: "snapshot_abc" });
  });

  it("skips a request still in flight", () => {
    const pending = { phase: "Suspending", suspend: { request: "snapshot_abc" } };
    expect(publishedSuspend(runner(requested, pending))).toBeUndefined();
  });

  it("skips a request that names no run", () => {
    expect(publishedSuspend(runner({ [SUSPEND_ANNOTATION]: "snapshot_abc" }))).toBeUndefined();
  });
});

describe("checkpoint locations", () => {
  it("round-trip the node and the snapshot", () => {
    const restore = { node: "ip-10-0-1-2.ec2.internal", snapshotID: "6f1c2a9e-snap" };
    expect(parseCheckpointLocation(checkpointLocation(restore))).toEqual(restore);
  });

  it.each(["", "snap", "/snap", "node/", "a/b/c"])("refuse %j", (location) => {
    expect(() => parseCheckpointLocation(location)).toThrow();
  });
});
