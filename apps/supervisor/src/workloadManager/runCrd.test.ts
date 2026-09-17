import { describe, expect, it } from "vitest";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { runnerBodyFor, runnerTokenSecretName } from "./runCrd.js";
import { getRunnerId } from "../util.js";
import type { WorkloadManagerCreateOptions } from "./types.js";

const meta = { name: "runner-abc123", namespace: "v4-runs" };

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

  // Empty is neither bun nor a node version, which is the same treatment an
  // absent runtime has always had. Sending a made-up default would change which
  // uid the container is pinned to.
  it("omits the task runtime rather than inventing one", () => {
    expect(runnerBodyFor(createOptions(), meta).spec).not.toHaveProperty("taskRuntime");
    expect(runnerBodyFor(createOptions({ runtime: "bun" }), meta).spec.taskRuntime).toBe("bun");
  });

  // Only the first value has ever reached a node selector, so carrying the list
  // would describe a choice nothing makes.
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

  // Nothing in the pod path reads a trace context or an attempt number: the
  // attempt is already in the object's name, and carrying a field nothing reads
  // is how a spec grows fields that quietly disagree with reality.
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
 * Ties every shared workload-manager create-option to the Runner that the
 * run-crd producer builds, so a new per-run option cannot be added and quietly
 * dropped. It is the class of drift that lost TRIGGER_SNAPSHOT_ROUTE: the field
 * was optional, three pod backends set it, and runCrd never did, which the type
 * checker was happy with.
 *
 * The property, stated once: every create-option field either changes the
 * Runner `runnerBodyFor` builds, or is listed in RUN_CRD_EXCLUDED with a reason.
 * Optionality is not an excuse; a silent drop is. It is checked by behaviour,
 * not by scanning source: for each field the test sets a probe value and asks
 * whether the built Runner changes. A comment, a log line, or a reference from
 * another method cannot fool that, where a textual `opts.<field>` scan could.
 */
describe("run-crd carries every shared create-option or excludes it on purpose", () => {
  /**
   * Every key of WorkloadManagerCreateOptions. Adding a field to the interface
   * without adding it here is a compile error (see the exhaustiveness assertion
   * below): a new option is acknowledged here or the build breaks.
   */
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
   * Create-option fields that do not change the Runner `runnerBodyFor` builds,
   * each with the reason it is not a spec field. Every such field must appear
   * here, so not carrying one is always a decision on the record rather than an
   * omission the type checker allowed. Some of these still shape creation by
   * another route, the runner's name or its token Secret; they just are not
   * values in the spec.
   *
   * snapshotRoute is superseded transport rather than a gap to fill: snapshot
   * routing is becoming server-owned, so the runner-facing route is being
   * removed rather than built into the Runner. This entry, the field on the
   * create options, and the pod backends that set it come out together when that
   * lands.
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
   * A value for each field that differs from createOptions()'s baseline, so a
   * field the producer builds in makes the Runner change and one it ignores
   * leaves it identical. Total over the keys, so a new option forces a probe
   * here too.
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
    // changesRunner reports any output difference, so a probe that also moved a
    // second option could pass without its own field being built in. Pinning
    // each probe to a single key keeps a difference attributable to that field.
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
