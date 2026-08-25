import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  cancelSupersededDeployments,
  supersededByForceReason,
} from "~/v3/services/initializeDeployment/cancelSupersededDeployments.server";
import type { ExternalIdReuseDeployment } from "~/v3/services/initializeDeployment/resolveExternalIdReuse.server";

type CancelOutcome =
  | { ok: true }
  | { type: "deployment_cannot_be_cancelled" }
  | { type: "deployment_not_found" }
  | { type: "failed_to_delete_deployment_timeout"; cause: unknown }
  | { type: "other"; cause: unknown };

function deployment(version: string): ExternalIdReuseDeployment {
  return {
    id: `id_${version}`,
    friendlyId: `deployment_${version}`,
    shortCode: `short_${version}`,
    version,
    status: "BUILDING",
    contentHash: `hash_${version}`,
    imageReference: `registry.example/image:${version}`,
    imagePlatform: "linux/amd64",
    externalId: "abc123",
  };
}

function stubDeploymentService(outcomes: CancelOutcome[]) {
  const attempted: string[] = [];
  const reasons: Array<string | undefined> = [];
  let call = 0;

  const deploymentService = {
    cancelDeployment(_env: { id: string }, friendlyId: string, data?: { canceledReason?: string }) {
      attempted.push(friendlyId);
      reasons.push(data?.canceledReason);

      const outcome = outcomes[call++] ?? { ok: true as const };
      return "ok" in outcome ? okAsync(undefined) : errAsync(outcome);
    },
  };

  return { deploymentService, attempted, reasons };
}

function run(
  outcomes: CancelOutcome[],
  deployments = [deployment("20260101.1")],
  externalId = "abc123"
) {
  const { deploymentService, attempted, reasons } = stubDeploymentService(outcomes);

  return {
    attempted,
    reasons,
    result: cancelSupersededDeployments({
      deploymentService: deploymentService as never,
      environmentId: "env_1",
      externalId,
      deployments,
    }),
  };
}

describe("cancelSupersededDeployments", () => {
  it("returns what it cancelled, naming the superseding deploy in the reason", async () => {
    const { result, attempted, reasons } = run([{ ok: true }]);

    await expect(result).resolves.toEqual([
      { version: "20260101.1", shortCode: "short_20260101.1" },
    ]);
    expect(attempted).toEqual(["deployment_20260101.1"]);
    expect(reasons).toEqual([supersededByForceReason("abc123")]);
  });

  it("cancels in the order it was given", async () => {
    const { result, attempted } = run(
      [{ ok: true }, { ok: true }, { ok: true }],
      [deployment("20260101.10"), deployment("20260101.9"), deployment("20260101.2")]
    );

    await expect(result).resolves.toHaveLength(3);
    expect(attempted).toEqual([
      "deployment_20260101.10",
      "deployment_20260101.9",
      "deployment_20260101.2",
    ]);
  });

  it("skips a deployment that went final before the cancel landed", async () => {
    const { result } = run([{ type: "deployment_cannot_be_cancelled" }]);

    await expect(result).resolves.toEqual([]);
  });

  it("skips a deployment that no longer exists", async () => {
    const { result } = run([{ type: "deployment_not_found" }]);

    await expect(result).resolves.toEqual([]);
  });

  it("counts a cancel whose timeout cleanup failed", async () => {
    const { result } = run([{ type: "failed_to_delete_deployment_timeout", cause: new Error() }]);

    await expect(result).resolves.toEqual([
      { version: "20260101.1", shortCode: "short_20260101.1" },
    ]);
  });

  it("keeps going after a skip", async () => {
    const { result, attempted } = run(
      [{ type: "deployment_cannot_be_cancelled" }, { ok: true }],
      [deployment("20260101.2"), deployment("20260101.1")]
    );

    await expect(result).resolves.toEqual([
      { version: "20260101.1", shortCode: "short_20260101.1" },
    ]);
    expect(attempted).toHaveLength(2);
  });

  it("throws and stops on a genuine failure", async () => {
    const { result, attempted } = run(
      [{ type: "other", cause: new Error("connection lost") }, { ok: true }],
      [deployment("20260101.2"), deployment("20260101.1")]
    );

    await expect(result).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(result).rejects.toMatchObject({ status: 500 });
    expect(attempted).toEqual(["deployment_20260101.2"]);
  });
});
