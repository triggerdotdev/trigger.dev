import { describe, expect, it } from "vitest";
import { mintWorkloadDeploymentToken, SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { unwrapWorkerId, unwrapWorkerIdInMetadata } from "~/v3/workerIdUnwrap.server";

const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const WORKER_ID_KEY = `${SemanticInternalAttributes.METADATA}.${SemanticInternalAttributes.WORKER_ID}`;

function mint(deployment: string) {
  return mintWorkloadDeploymentToken(
    {
      deployment,
      deployment_version: "20260709.1",
      environment_id: "env_1",
      environment_type: "PRODUCTION",
      org_id: "org_1",
      project_id: "proj_1",
    },
    "any-secret",
    EXP
  );
}

describe("unwrapWorkerId", () => {
  it("unwraps a real minted token to its deployment friendlyId", async () => {
    // Decode is signature-independent (display-only), so the secret is irrelevant here.
    expect(unwrapWorkerId(await mint("deployment_abc123"))).toBe("deployment_abc123");
  });

  it("passes a legacy bare friendlyId through unchanged", () => {
    expect(unwrapWorkerId("deployment_legacy")).toBe("deployment_legacy");
  });

  it("passes undefined and garbage through unchanged (fail-safe)", () => {
    expect(unwrapWorkerId(undefined)).toBeUndefined();
    expect(unwrapWorkerId("")).toBe("");
    expect(unwrapWorkerId("a.b.c")).toBe("a.b.c");
    expect(unwrapWorkerId("not-a-token")).toBe("not-a-token");
  });

  it("is stable across repeated calls (memoized)", async () => {
    const token = await mint("deployment_memo");
    expect(unwrapWorkerId(token)).toBe("deployment_memo");
    expect(unwrapWorkerId(token)).toBe("deployment_memo");
  });
});

describe("unwrapWorkerIdInMetadata", () => {
  it("unwraps a token worker.id in the metadata bag, leaving other keys untouched", async () => {
    const metadata = {
      [WORKER_ID_KEY]: await mint("deployment_span"),
      "$metadata.custom": "keep-me",
      "$metadata.worker.version": "20260709.1",
    };

    const result = unwrapWorkerIdInMetadata(metadata);

    expect(result?.[WORKER_ID_KEY]).toBe("deployment_span");
    expect(result?.["$metadata.custom"]).toBe("keep-me");
    expect(result?.["$metadata.worker.version"]).toBe("20260709.1");
  });

  it("leaves a legacy bare friendlyId worker.id unchanged", () => {
    const metadata = { [WORKER_ID_KEY]: "deployment_legacy" };
    expect(unwrapWorkerIdInMetadata(metadata)?.[WORKER_ID_KEY]).toBe("deployment_legacy");
  });

  it("handles absent worker.id and undefined metadata", () => {
    expect(unwrapWorkerIdInMetadata(undefined)).toBeUndefined();
    expect(unwrapWorkerIdInMetadata({ "$metadata.other": "x" })?.["$metadata.other"]).toBe("x");
  });
});
