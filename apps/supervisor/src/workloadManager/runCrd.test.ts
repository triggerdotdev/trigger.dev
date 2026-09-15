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
