import type {
  DeploymentCheckDecision,
  DeploymentCheckInput,
  DeploymentCheckResult,
  DeploymentChecksController,
} from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_CHECK_UNAVAILABLE_MESSAGE,
  deploymentCheckTelemetry,
  deploymentRefusedMessage,
  gateDeployment,
  type DeploymentGateDependencies,
} from "~/v3/deploymentChecks.server";
import type { ResolvedImage } from "~/v3/services/verifyDeploymentImage.server";
import { latestMetrics, metricSum } from "./otlpMetrics.helpers";
import { createInMemoryMetrics } from "./utils/tracing";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const OCI = "application/vnd.oci.image.manifest.v1+json";
const GATE: DeploymentCheckDecision = { plan: "gate", selectedBy: "org_override" };
const IMAGE = {
  manifest: '{"schemaVersion":2}',
  mediaType: OCI,
  blobUrls: { [DIGEST]: "https://layers.s3.us-east-1.amazonaws.com/a" },
};
const READ = { kind: "read", image: IMAGE } as const;
const READ_RETRY = { kind: "retry", reason: "timed out after 20000 ms" } as const;
const PASS: DeploymentCheckResult = { outcome: "pass", id: "check_1", retryable: false };
const REFUSED = {
  kind: "refuse",
  error: { name: "DeploymentFailed", message: deploymentRefusedMessage("deployment_abc123") },
};
const TRY_AGAIN = {
  kind: "refuse",
  error: { name: "DeploymentFailed", message: DEPLOYMENT_CHECK_UNAVAILABLE_MESSAGE },
};

const deployment = {
  id: "deployment_internal_1",
  friendlyId: "deployment_abc123",
  imageReference: "registry.example.com/deployments/proj_test:20260101.1.prod",
  type: "MANAGED",
  organizationId: "org_1",
  projectRef: "proj_test",
};

/**
 * A plugin with a fixed decision that answers checks in turn (the last answer repeats) and keeps
 * what it was asked.
 */
function plugin(
  decision: DeploymentCheckDecision | Error = GATE,
  ...results: DeploymentCheckResult[]
) {
  const answers = results.length > 0 ? results : [PASS];
  const checks: DeploymentCheckInput[] = [];
  let decided = 0;
  const controller: DeploymentChecksController = {
    async decide() {
      decided++;
      if (decision instanceof Error) throw decision;
      return decision;
    },
    async check(input) {
      checks.push(input);
      return answers[Math.min(checks.length, answers.length) - 1]!;
    },
  };
  return { controller, checks, decided: () => decided };
}

function deps(
  controller: DeploymentChecksController | null,
  overrides: Partial<DeploymentGateDependencies> & { resolved?: ResolvedImage } = {}
) {
  const metrics = createInMemoryMetrics();
  const extended: string[] = [];
  const { resolved = { kind: "found", digest: DIGEST, mediaType: OCI }, ...rest } = overrides;
  return {
    metrics,
    extended,
    value: {
      controller,
      canRun: () => true,
      resolveImage: async () => resolved,
      readImage: async () => READ,
      extendTimeout: async (deploymentId: string) => {
        extended.push(deploymentId);
      },
      telemetry: deploymentCheckTelemetry(metrics.meter),
      ...rest,
    } satisfies DeploymentGateDependencies,
  };
}

async function decisions(
  metrics: ReturnType<typeof createInMemoryMetrics>,
  attributes: Record<string, string> = {}
) {
  return metricSum(await latestMetrics(metrics), "deployment_checks.decisions_total", attributes);
}

describe("gateDeployment", () => {
  it("continues a deploy the plugin doesn't select at finalize", async () => {
    // Catches: such a deploy waiting, refused, or its timeout moved.
    for (const decision of [
      { plan: "shadow", selectedBy: "sampled" } as const,
      { plan: "skip", selectedBy: "not_sampled" } as const,
      { plan: "shadow", selectedBy: "org_override" } as const,
    ]) {
      const p = plugin(decision);
      const d = deps(p.controller);
      expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual({
        kind: "proceed",
        checked: false,
      });
      expect(p.checks).toHaveLength(0);
      expect(d.extended).toEqual([]);
      expect(await decisions(d.metrics)).toBe(0);
    }
  });

  it("checks the digest the tag resolves to, and continues on a passing outcome", async () => {
    // Catches: the check reading the client's digest, the image not sent, or a passing outcome refused.
    for (const outcome of ["pass", "flagged"] as const) {
      const p = plugin(GATE, { outcome, id: "check_1", retryable: false });
      const d = deps(p.controller);
      expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual({
        kind: "proceed",
        checked: true,
        imageDigest: DIGEST,
      });
      expect(p.checks).toEqual([
        {
          organizationId: "org_1",
          projectRef: "proj_test",
          deploymentId: "deployment_internal_1",
          imageDigest: DIGEST,
          image: IMAGE,
          decision: GATE,
        },
      ]);
      expect(await decisions(d.metrics, { mode: "gate", outcome, stage: "finalize" })).toBe(1);
    }
  });

  it("extends the timeout once before the check", async () => {
    // Catches: the deployment timing out during the step, or a timeout that couldn't be extended
    // failing the deploy.
    const p = plugin();
    const d = deps(p.controller);
    await gateDeployment(deployment, DIGEST, d.value);
    expect(d.extended).toEqual(["deployment_internal_1"]);

    const refused = deps(
      plugin(GATE, { outcome: "fail", id: "check_1", retryable: false }).controller
    );
    await gateDeployment(deployment, DIGEST, refused.value);
    expect(refused.extended).toEqual(["deployment_internal_1"]);

    const failing = deps(plugin().controller, {
      extendTimeout: async () => {
        throw new Error("queue down");
      },
    });
    expect(await gateDeployment(deployment, DIGEST, failing.value)).toMatchObject({
      kind: "proceed",
      checked: true,
    });
  });

  it("checks the tag's digest when the client reported none", async () => {
    const p = plugin();
    const result = await gateDeployment(deployment, undefined, deps(p.controller).value);
    expect(result).toEqual({ kind: "proceed", checked: true, imageDigest: DIGEST });
    expect(p.checks[0]?.imageDigest).toBe(DIGEST);
  });

  it("refuses a failed check with the generic message and the deployment's ID", async () => {
    // Catches: a refused deploy going on, or a message that says why.
    const p = plugin(GATE, { outcome: "fail", id: "check_1", retryable: false });
    const { value, metrics } = deps(p.controller);
    expect(await gateDeployment(deployment, DIGEST, value)).toEqual(REFUSED);
    expect(deploymentRefusedMessage("deployment_abc123")).toBe(
      "This deployment could not be completed. If you think this is a mistake, contact support and provide the ID: deployment_abc123."
    );
    expect(await decisions(metrics, { mode: "gate", outcome: "fail", stage: "finalize" })).toBe(1);
  });

  it("retries once on a temporary failure", async () => {
    // Catches: a temporary failure failing the deploy, so the user has to build it again.
    const p = plugin(GATE, { outcome: "unavailable", id: "check_1", retryable: true }, PASS);
    const result = await gateDeployment(deployment, DIGEST, deps(p.controller).value);
    expect(result).toEqual({ kind: "proceed", checked: true, imageDigest: DIGEST });
    expect(p.checks).toHaveLength(2);
  });

  it("refuses when the check has no answer, with a message that depends on whether retrying may help", async () => {
    // Catches: the deploy going on, a third try, a retry of an answer that won't change, or asking
    // the user to retry what fails every time.
    const mayChange = plugin(GATE, { outcome: "unavailable", id: "check_1", retryable: true });
    const d = deps(mayChange.controller);
    expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual(TRY_AGAIN);
    expect(mayChange.checks).toHaveLength(2);
    expect(
      await decisions(d.metrics, { mode: "gate", outcome: "unavailable", stage: "finalize" })
    ).toBe(1);

    const final = plugin(GATE, { outcome: "unavailable", id: "check_1", retryable: false });
    expect(await gateDeployment(deployment, DIGEST, deps(final.controller).value)).toEqual(REFUSED);
    expect(final.checks).toHaveLength(1);
  });

  it("refuses a reported digest that doesn't match the tag", async () => {
    // Catches: a check on a digest other than the one the deployment is stored with.
    const p = plugin();
    const result = await gateDeployment(deployment, OTHER, deps(p.controller).value);
    expect(result).toEqual(REFUSED);
    expect(p.checks).toHaveLength(0);
  });

  it("ignores a malformed reported digest", async () => {
    // Catches: a malformed reported digest refusing the deploy.
    for (const reported of ["not-a-digest", `SHA256:${"A".repeat(64)}`]) {
      const p = plugin();
      const result = await gateDeployment(deployment, reported, deps(p.controller).value);
      expect(result).toEqual({ kind: "proceed", checked: true, imageDigest: DIGEST });
    }
  });

  it("refuses a manifest type that isn't accepted", async () => {
    // Catches: a deploy finalized with a manifest type that isn't accepted.
    for (const mediaType of [
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
      undefined,
    ]) {
      const p = plugin();
      const resolved: ResolvedImage = { kind: "found", digest: DIGEST, mediaType };
      const result = await gateDeployment(
        deployment,
        DIGEST,
        deps(p.controller, { resolved }).value
      );
      expect(result).toEqual(REFUSED);
      expect(p.checks).toHaveLength(0);
    }
  });

  it("refuses when the tag can't be looked up, or the deployment has no image", async () => {
    // Catches: the deploy going on when its image can't be found.
    for (const resolved of [{ kind: "missing" }, { kind: "unknown" }] as const) {
      const p = plugin();
      const result = await gateDeployment(
        deployment,
        DIGEST,
        deps(p.controller, { resolved }).value
      );
      expect(result).toEqual(TRY_AGAIN);
      expect(p.checks).toHaveLength(0);
    }
    const p = plugin();
    const noImage = await gateDeployment(
      { ...deployment, imageReference: null },
      DIGEST,
      deps(p.controller).value
    );
    expect(noImage).toEqual(REFUSED);
  });

  it("refuses when anything in the check throws", async () => {
    // Catches: an error letting the deploy go on, or failing finalize with a 500.
    const p = plugin();
    const result = await gateDeployment(
      deployment,
      DIGEST,
      deps(p.controller, {
        readImage: async () => {
          throw new Error("registry down");
        },
      }).value
    );
    expect(result).toEqual(TRY_AGAIN);
  });

  it("continues and records a failed decision", async () => {
    // Catches: a failed decision blocking every deploy, or going unrecorded.
    const broken = plugin(new Error("decide broke"));
    const d = deps(broken.controller);
    expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual({
      kind: "proceed",
      checked: false,
    });
    expect(broken.checks).toHaveLength(0);
    expect(d.extended).toEqual([]);
    expect(
      await decisions(d.metrics, {
        mode: "skip",
        selected_by: "decision_failed",
        outcome: "skipped",
        stage: "finalize",
      })
    ).toBe(1);
    expect(await decisions(d.metrics, { mode: "gate" })).toBe(0);

    const odd = plugin({ plan: "unknown", selectedBy: "sampled" } as never);
    const o = deps(odd.controller);
    expect(await gateDeployment(deployment, DIGEST, o.value)).toEqual({
      kind: "proceed",
      checked: false,
    });
    expect(odd.checks).toHaveLength(0);
    expect(await decisions(o.metrics, { selected_by: "decision_failed" })).toBe(1);

    const unlabelled = plugin({ plan: "gate" } as never);
    const u = deps(unlabelled.controller);
    expect(await gateDeployment(deployment, DIGEST, u.value)).toEqual({
      kind: "proceed",
      checked: false,
    });
    expect(unlabelled.checks).toHaveLength(0);
    expect(await decisions(u.metrics, { selected_by: "decision_failed" })).toBe(1);
  });

  it("records decisions made without the org's settings", async () => {
    // Catches: such decisions left out of the metrics.
    for (const selectedBy of ["settings_unavailable", "org_not_found"]) {
      const p = plugin({ plan: "skip", selectedBy });
      const d = deps(p.controller);
      expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual({
        kind: "proceed",
        checked: false,
      });
      expect(
        await decisions(d.metrics, {
          selected_by: selectedBy,
          outcome: "skipped",
          stage: "finalize",
        })
      ).toBe(1);
    }
  });

  it("never checks without the image: reads once more, then says deploy again", async () => {
    // Catches: a check sent without the image, or a read that may work next time refusing for good
    // or retried without end.
    const p = plugin();
    const reads: unknown[] = [];
    const d = deps(p.controller, {
      readImage: async (input) => {
        reads.push(input);
        return READ_RETRY;
      },
    });
    expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual(TRY_AGAIN);
    // Read twice, each time for the digest the gate resolved, in the project's own repository.
    const input = {
      imageReference: deployment.imageReference,
      imageDigest: DIGEST,
      projectRef: deployment.projectRef,
      isV4Deployment: true,
    };
    expect(reads).toEqual([input, input]);
    expect(p.checks).toHaveLength(0);
    expect(
      await decisions(d.metrics, { mode: "gate", outcome: "unavailable", stage: "finalize" })
    ).toBe(1);

    // A read that works the second time is checked as usual.
    const q = plugin();
    let second = 0;
    const e = deps(q.controller, { readImage: async () => (second++ === 0 ? READ_RETRY : READ) });
    expect(await gateDeployment(deployment, DIGEST, e.value)).toMatchObject({ kind: "proceed" });
    expect(q.checks).toHaveLength(1);
    expect(q.checks[0]?.image).toEqual(IMAGE);

    // A check with no answer worth retrying whose second read fails is still "deploy again".
    const r = plugin(GATE, { outcome: "unavailable", id: "check_1", retryable: true });
    let third = 0;
    const f = deps(r.controller, { readImage: async () => (third++ === 0 ? READ : READ_RETRY) });
    expect(await gateDeployment(deployment, DIGEST, f.value)).toEqual(TRY_AGAIN);
    expect(third).toBe(2);
    expect(r.checks).toHaveLength(1);
    expect(
      await decisions(f.metrics, { mode: "gate", outcome: "unavailable", stage: "finalize" })
    ).toBe(1);
  });

  it("refuses without a check when the image can't be read here, with the right message", async () => {
    // Catches: a deploy told to try again when it never can (an image over the caps, not the
    // project's own), one told to contact support when another host could read it, or a read
    // repeated for nothing.
    for (const [kind, outcome, refusal] of [
      ["unreadable", "fail", REFUSED],
      ["not_configured", "unavailable", TRY_AGAIN],
    ] as const) {
      const p = plugin();
      let reads = 0;
      const d = deps(p.controller, {
        readImage: async () => {
          reads++;
          return { kind, reason: "test" };
        },
      });
      expect(await gateDeployment(deployment, DIGEST, d.value)).toEqual(refusal);
      expect(reads).toBe(1);
      expect(p.checks).toHaveLength(0);
      expect(await decisions(d.metrics, { mode: "gate", outcome, stage: "finalize" })).toBe(1);
    }
  });

  it("does nothing off Cloud, and records a missing plugin", async () => {
    // Catches: self-hosted deploys depending on a plugin they don't have.
    const p = plugin();
    const offCloud = deps(p.controller, { canRun: () => false });
    expect(await gateDeployment(deployment, DIGEST, offCloud.value)).toEqual({
      kind: "proceed",
      checked: false,
    });
    expect(p.decided()).toBe(0);

    const missing = deps(null);
    expect(await gateDeployment(deployment, DIGEST, missing.value)).toEqual({
      kind: "proceed",
      checked: false,
    });
    expect(
      metricSum(await latestMetrics(missing.metrics), "deployment_checks.plugin_missing_total")
    ).toBe(1);
  });
});
