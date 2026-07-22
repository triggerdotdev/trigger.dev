import { describe, expect, it } from "vitest";
import { generateJWT } from "./jwt.js";
import {
  classifyDeploymentIdHeader,
  looksLikeWorkloadDeploymentToken,
  mintWorkloadDeploymentToken,
  verifyWorkloadDeploymentToken,
  WORKLOAD_DEPLOYMENT_TOKEN_VERSION,
  type WorkloadDeploymentTokenInput,
} from "./workloadDeploymentToken.js";

const SECRET = "test-workload-token-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);

const claims: WorkloadDeploymentTokenInput = {
  deployment: "deployment_abc123",
  deployment_version: "20260709.1",
  environment_id: "env_1",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};

describe("workloadDeploymentToken", () => {
  it("mints a token that verifies and round-trips every claim", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    const result = await verifyWorkloadDeploymentToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.claims.ver).toBe(WORKLOAD_DEPLOYMENT_TOKEN_VERSION);
    expect(result.claims.deployment).toBe(claims.deployment);
    expect(result.claims.deployment_version).toBe(claims.deployment_version);
    expect(result.claims.environment_id).toBe(claims.environment_id);
    expect(result.claims.environment_type).toBe(claims.environment_type);
    expect(result.claims.org_id).toBe(claims.org_id);
    expect(result.claims.project_id).toBe(claims.project_id);
  });

  it("sets the caller-supplied absolute exp", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const result = await verifyWorkloadDeploymentToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.claims.exp).toBe(EXP);
  });

  it("mints byte-identical tokens for identical claims (deterministic, no iat)", async () => {
    const a = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const b = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    expect(a).toBe(b);

    const result = await verifyWorkloadDeploymentToken(a, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.claims as Record<string, unknown>).iat).toBeUndefined();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const result = await verifyWorkloadDeploymentToken(token, "wrong-secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects a tampered token", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const [header, payload, signature] = token.split(".");
    const tampered = `${header}.${payload}x.${signature}`;
    const result = await verifyWorkloadDeploymentToken(tampered, SECRET);
    expect(result.ok).toBe(false);
  });

  it("rejects a valid JWT that is missing required claims", async () => {
    // Signed with the right secret, but not a workload deployment token.
    const token = await generateJWT({
      secretKey: SECRET,
      payload: { foo: "bar" },
      expirationTime: "1825d",
    });
    const result = await verifyWorkloadDeploymentToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_claims");
  });

  describe("looksLikeWorkloadDeploymentToken", () => {
    it("is true for a minted token", async () => {
      const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
      expect(looksLikeWorkloadDeploymentToken(token)).toBe(true);
    });

    it("is false for a legacy bare friendlyId", () => {
      expect(looksLikeWorkloadDeploymentToken("deployment_abc123")).toBe(false);
    });

    it("is false for empty and malformed values", () => {
      expect(looksLikeWorkloadDeploymentToken("")).toBe(false);
      expect(looksLikeWorkloadDeploymentToken("a.b")).toBe(false);
      expect(looksLikeWorkloadDeploymentToken("a..c")).toBe(false);
    });
  });

  describe("classifyDeploymentIdHeader", () => {
    it("classifies a minted token as jwt_valid and returns claims", async () => {
      const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
      const result = await classifyDeploymentIdHeader(token, SECRET);
      expect(result.outcome).toBe("jwt_valid");
      expect(result.claims?.deployment).toBe(claims.deployment);
    });

    it("classifies a JWT with a bad signature as jwt_invalid", async () => {
      const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
      const result = await classifyDeploymentIdHeader(token, "wrong-secret");
      expect(result.outcome).toBe("jwt_invalid");
      expect(result.claims).toBeUndefined();
    });

    it("classifies a bare friendlyId as legacy_bare", async () => {
      const result = await classifyDeploymentIdHeader("deployment_abc123", SECRET);
      expect(result.outcome).toBe("legacy_bare");
    });
  });
});
