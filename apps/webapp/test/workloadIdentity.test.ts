import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  serviceCallerAuthenticated,
  verifyWorkloadToken,
  WorkloadIdentityUnavailableError,
} from "~/services/workloadIdentity.server";

const subject = "system:serviceaccount:v4-infra:secret-proxy-relay";
const audience = "secret-proxy-resolver.trigger.dev";
let issuer: string;
let brokenIssuer: string;
let server: Server;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

// A local issuer serves real discovery and key documents.
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k", alg: "RS256" }] };
  server = createServer((request, response) => {
    const [, prefix, ...rest] = request.url!.split("/");
    const base = `${origin}/${prefix}`;
    if (prefix === "broken" && rest.join("/") === "keys") {
      response.writeHead(503).end();
    } else if (rest.join("/") === ".well-known/openid-configuration") {
      response.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/keys` }));
    } else if (rest.join("/") === "keys") {
      response.end(JSON.stringify(jwks));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  issuer = `${origin}/ok`;
  brokenIssuer = `${origin}/broken`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const policy = () => ({ issuers: [issuer, brokenIssuer], audience, subject });

async function sign(
  overrides: Record<string, unknown> = {},
  { lifetime = 600, key = keys.privateKey }: { lifetime?: number; key?: KeyLike } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: [audience],
    sub: subject,
    iat: now,
    exp: now + lifetime,
    "kubernetes.io": {
      namespace: "v4-infra",
      pod: { name: "secret-proxy-relay-abc", uid: "pod-uid" },
      serviceaccount: { name: "secret-proxy-relay", uid: "sa-uid" },
    },
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .sign(key);
}

describe("verifyWorkloadToken", () => {
  it("accepts a pod-bound token of the expected account from a trusted issuer", async () => {
    expect(await verifyWorkloadToken(await sign(), policy())).toBe(true);
  });

  it("rejects anything else", async () => {
    const other = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const rejected = [
      "not-a-jwt",
      await sign({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/OTHER" }),
      await sign({ aud: ["https://kubernetes.default.svc"] }),
      await sign({ sub: "system:serviceaccount:v4-infra:other" }),
      // A legacy Secret-based token is not bound to a pod.
      await sign({ "kubernetes.io": { namespace: "v4-infra" } }),
      await sign({}, { lifetime: 3607 }),
      await sign({ iat: now - 700, exp: now - 100 }),
      await sign({}, { key: other.privateKey }),
    ];
    for (const token of rejected) {
      expect(await verifyWorkloadToken(token, policy())).toBe(false);
    }
    expect(await verifyWorkloadToken(await sign(), { ...policy(), subject: "" })).toBe(false);
  });

  it("reports an issuer whose keys cannot be fetched as unavailable, not as a bad token", async () => {
    await expect(
      verifyWorkloadToken(await sign({ iss: brokenIssuer }), policy())
    ).rejects.toBeInstanceOf(WorkloadIdentityUnavailableError);
  });
});

describe("serviceCallerAuthenticated", () => {
  it("with trusted issuers, accepts only a workload token", async () => {
    const caller = { kind: "workload" as const, policy: policy() };
    expect(await serviceCallerAuthenticated(await sign(), caller)).toBe(true);
    expect(await serviceCallerAuthenticated("shared-service-token", caller)).toBe(false);
  });

  it("without trusted issuers, accepts only the shared token", async () => {
    const caller = { kind: "sharedToken" as const, token: "shared-service-token" };
    expect(await serviceCallerAuthenticated("shared-service-token", caller)).toBe(true);
    for (const bearer of [undefined, "", "shared-service-tokeN", await sign()]) {
      expect(await serviceCallerAuthenticated(bearer, caller)).toBe(false);
    }
  });
});
