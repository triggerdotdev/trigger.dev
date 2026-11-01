import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import {
  generateFriendlyId,
  generateRunOpsId,
  generateRunOpsIdV2,
  parseRunId,
} from "@trigger.dev/core/v3/isomorphic";
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "current-secret";
const PREVIOUS_SECRET = "previous-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);

const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_1",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};

async function loadWorkloadToken(extraEnv: Record<string, string>) {
  vi.resetModules();
  vi.doMock("std-env", () => ({
    env: {
      TRIGGER_API_URL: "http://localhost:3030",
      TRIGGER_WORKER_TOKEN: "test-token",
      MANAGED_WORKER_SECRET: "test-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      WORKLOAD_TOKEN_SECRET: SECRET,
      WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
      ...extraEnv,
    },
  }));
  return import("./workloadToken.js");
}

function runIdCreatedAt(ms: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return `run_${generateRunOpsId("us-east-1")}`;
  } finally {
    now.mockRestore();
  }
}

function gen2RunIdCreatedAt(ms: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return `run_${generateRunOpsIdV2("a")}`;
  } finally {
    now.mockRestore();
  }
}

afterEach(() => {
  vi.doUnmock("std-env");
});

describe("verifyDeploymentIdHeader key selection", () => {
  it("verifies a current-key token as key current", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    const result = await verifyDeploymentIdHeader(token, "http");

    expect(result).toMatchObject({ outcome: "jwt_valid", key: "current" });
  });

  it("verifies a previous-key token as key previous", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, PREVIOUS_SECRET, EXP);

    const result = await verifyDeploymentIdHeader(token, "http");

    expect(result).toMatchObject({ outcome: "jwt_valid", key: "previous", claims });
  });

  it("rejects a token signed with neither key", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, "other-secret", EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toEqual({ outcome: "jwt_invalid" });
  });

  it("ignores an empty previous secret", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: "",
    });
    const token = await mintWorkloadDeploymentToken(claims, "", EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toEqual({ outcome: "jwt_invalid" });
  });

  it("treats a previous secret equal to the current one as unset", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "current",
    });
  });
});

describe("checkPreviousKeyRunCutoff", () => {
  it("passes every run when no cutoff is set", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });

    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2030, 0, 1)))).toBe("pass");
  });

  it("passes runs created before the cutoff, fails runs at or after it", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
    });

    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 4, 31)))).toBe("pass");
    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 5, 1)))).toBe("fail");
    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 9, 1)))).toBe("fail");
  });

  it("passes every legacy run id shape when a cutoff is set", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
    });
    const nanoid = generateFriendlyId("run");
    const base62 = "run_2xK9mQ7vRtZ4bN8cW1pL5sYfH0j";

    expect(nanoid).toMatch(/^run_[1-9a-km-z]{21}$/);
    expect(base62.length - "run_".length).toBe(27);
    expect(parseRunId(nanoid).format).toBe("legacy");
    expect(parseRunId(base62).format).toBe("legacy");

    expect(checkPreviousKeyRunCutoff(nanoid)).toBe("pass");
    expect(checkPreviousKeyRunCutoff(base62)).toBe("pass");
    expect(checkPreviousKeyRunCutoff("run_cm1legacy0000000000000")).toBe("pass");
  });

  it("fails a non-string run id instead of throwing, with or without a cutoff", async () => {
    const withoutCutoff = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    expect(withoutCutoff.checkPreviousKeyRunCutoff(123)).toBe("fail");
    expect(withoutCutoff.checkPreviousKeyRunCutoff(undefined)).toBe("fail");

    const withCutoff = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
    });
    expect(withCutoff.checkPreviousKeyRunCutoff(123)).toBe("fail");
    expect(withCutoff.checkPreviousKeyRunCutoff(undefined)).toBe("fail");
  });

  it("applies the cutoff to gen-2 run ids", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
    });
    const before = gen2RunIdCreatedAt(Date.UTC(2026, 4, 31));
    const after = gen2RunIdCreatedAt(Date.UTC(2026, 9, 1));

    expect(parseRunId(before).format).toBe("b32hexV2");
    expect(parseRunId(after).format).toBe("b32hexV2");

    expect(checkPreviousKeyRunCutoff(before)).toBe("pass");
    expect(checkPreviousKeyRunCutoff(after)).toBe("fail");
  });

  it("fails an id without the run_ prefix, even one that parseRunId calls legacy", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
    });
    const postCutoffBody = runIdCreatedAt(Date.UTC(2026, 9, 1)).slice("run_".length);

    expect(checkPreviousKeyRunCutoff(`x_${postCutoffBody}`)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(postCutoffBody)).toBe("fail");
    expect(checkPreviousKeyRunCutoff("x_cm1legacy0000000000000")).toBe("fail");
    expect(checkPreviousKeyRunCutoff("run_cm1legacy0000000000000")).toBe("pass");
  });
});
