import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import {
  RunCrdWorkloadManager,
  SUSPEND_ANNOTATION,
  SUSPEND_RUN_ANNOTATION,
  SUSPEND_SUBMITTED_ANNOTATION,
  checkpointLocation,
  parseCheckpointLocation,
  publishedSuspend,
  runnerBodyFor,
  runnerTokenSecretName,
  suspendOutcome,
} from "./runCrd.js";
import { getRestoreRunnerId, getRunnerId } from "../util.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

const createRunner = vi.fn();
const getRunner = vi.fn();
const listRunners = vi.fn();
const patchObject = vi.fn();

vi.mock("../clients/kubernetes.js", () => ({
  createK8sApi: () => ({
    custom: {
      createNamespacedCustomObject: createRunner,
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
    createRunner.mockResolvedValue({});
    getRunner.mockReset();
  });

  function existing(
    phase: string | undefined,
    restore = { snapshotID: "6f1c2a9e-snap", node: "node-a" }
  ) {
    return {
      metadata: { name: "runner-abc123" },
      spec: { restore },
      status: phase ? { phase } : undefined,
    };
  }

  it("creates a Runner named from the checkpoint that restores its location", async () => {
    await manager().restore(createOptions(), checkpoint);

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

      await expect(manager().restore(createOptions(), checkpoint)).resolves.toBeUndefined();
      expect(getRunner).toHaveBeenCalledWith(
        expect.objectContaining({ name: getRestoreRunnerId("run_abc123", "checkpoint_abc") })
      );
    }
  );

  // Held for the operator's TTL, it will never resume the guest.
  it.each(["Failed", "Succeeded"])("fails when the resume in the way has %s", async (phase) => {
    createRunner.mockRejectedValue({ code: 409 });
    getRunner.mockResolvedValue(existing(phase));

    await expect(manager().restore(createOptions(), checkpoint)).rejects.toThrow(
      `already ended (${phase})`
    );
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
    getRunner.mockRejectedValue({ code: 404 });

    await expect(manager().restore(createOptions(), checkpoint)).rejects.toEqual({ code: 404 });
  });

  it("still fails a cold start that finds a Runner in the way", async () => {
    createRunner.mockRejectedValue({ code: 409 });

    await expect(manager().create(createOptions())).rejects.toEqual({ code: 409 });
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
