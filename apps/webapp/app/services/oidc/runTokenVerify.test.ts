import { describe, expect, it } from "vitest";
import { generateRs256KeyPair, importRs256PrivateKey, signRs256Jwt } from "./crypto";
import {
  RUN_TOKEN_AUDIENCE,
  RUN_TOKEN_TYPE,
  RUN_TOKEN_USE,
  runTokenScopes,
} from "./runTokenClaims";
import { isRunTokenFormat, verifyRunToken } from "./runTokenVerify";

const issuer = "https://run.example.com";
const claims = {
  token_use: RUN_TOKEN_USE,
  org_id: "org_1",
  project_id: "proj_1",
  environment_id: "env_1",
  run_id: "run_1",
  attempt: 1,
  scopes: runTokenScopes("run_1"),
};

async function setup() {
  const key = await generateRs256KeyPair();
  const privateKey = await importRs256PrivateKey(key.privateKeyPkcs8);
  const sign = (overrides: Partial<Parameters<typeof signRs256Jwt>[0]> = {}) =>
    signRs256Jwt({
      payload: claims,
      privateKey,
      kid: key.kid,
      issuer,
      audience: RUN_TOKEN_AUDIENCE,
      subject: "run:run_1",
      expiresInSeconds: 900,
      typ: RUN_TOKEN_TYPE,
      ...overrides,
    });
  return { jwks: { keys: [key.publicJwk] }, sign };
}

describe("run tokens", () => {
  it("verifies a run token and returns its claims", async () => {
    const { jwks, sign } = await setup();
    const token = await sign();

    expect(isRunTokenFormat(token)).toBe(true);
    await expect(verifyRunToken({ token, jwks, issuer })).resolves.toEqual(claims);
  });

  it("rejects a run token from another issuer", async () => {
    const { jwks, sign } = await setup();
    const token = await sign({ issuer: "https://oidc.example.com" });

    await expect(verifyRunToken({ token, jwks, issuer })).resolves.toBeUndefined();
  });

  it("rejects an audience array even when it contains the run token audience", async () => {
    const { jwks, sign } = await setup();
    const token = await sign({ audience: [RUN_TOKEN_AUDIENCE, "sts.amazonaws.com"] });

    await expect(verifyRunToken({ token, jwks, issuer })).resolves.toBeUndefined();
  });

  it("rejects a run token for another audience or from an unknown key", async () => {
    const { jwks, sign } = await setup();
    const otherAudience = await sign({ audience: "sts.amazonaws.com" });
    await expect(verifyRunToken({ token: otherAudience, jwks, issuer })).resolves.toBeUndefined();

    const other = await setup();
    const unknownKey = await other.sign();
    await expect(verifyRunToken({ token: unknownKey, jwks, issuer })).resolves.toBeUndefined();
  });

  it("does not treat API keys or external OIDC tokens as run tokens", async () => {
    const { sign } = await setup();
    expect(isRunTokenFormat("tr_prod_abc123")).toBe(false);
    expect(isRunTokenFormat(await sign({ typ: "JWT" }))).toBe(false);
  });
});
