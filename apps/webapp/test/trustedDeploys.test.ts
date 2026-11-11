import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWithZod } from "@conform-to/zod/v4";
import {
  publishingPolicyFromForm,
  EnvironmentFormSchema,
  RepositoryFormSchema,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.trusted-publishing/schemas";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  GITHUB_ACTIONS_ISSUER,
  SubmitTrustedDeployRequest,
  TRUSTED_DEPLOY_AUDIENCE,
} from "@trigger.dev/core/v3";
import { verifyGithubDeployToken } from "~/services/trustedDeploys/github.server";
import { matchesTrustedDeploy, type GithubDeployClaims } from "~/services/trustedDeploys/policy";

const claims: GithubDeployClaims = {
  iss: GITHUB_ACTIONS_ISSUER,
  sub: "repo:acme/tasks:environment:production",
  repository: "acme/tasks",
  repository_id: "123",
  repository_owner: "acme",
  repository_owner_id: "456",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
  event_name: "push",
  run_id: "789",
  run_attempt: "1",
  workflow_ref: "acme/tasks/.github/workflows/deploy.yml@refs/heads/main",
  environment: "production",
};
const repository = {
  issuer: GITHUB_ACTIONS_ISSUER,
  repositoryOwner: "acme",
  repositoryName: "tasks",
  repositoryId: "123",
  repositoryOwnerId: "456",
};
const grant = {
  environmentType: "PRODUCTION" as const,
  enabled: true,
  scope: "BRANCH" as const,
  scopeValue: "main",
  additionalClaims: { environment: ["production"] },
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "github" }] });
});

async function sign(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    ...claims,
    aud: TRUSTED_DEPLOY_AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "github" })
    .sign(keys.privateKey);
}

describe("trusted deployment authorization", () => {
  // Catches: name@ID fields being stored as literal names instead of pinned identities.
  it("parses optional owner and repository IDs through the actual form schema", () => {
    const formData = new FormData();
    formData.set("intent", "repository");
    formData.set("repositoryOwner", "acme@456");
    formData.set("repositoryName", "tasks@123");
    const submission = parseWithZod(formData, { schema: RepositoryFormSchema });
    expect(submission.status).toBe("success");
    if (submission.status !== "success") throw new Error("Expected a valid repository form.");
    expect(submission.value).toMatchObject({
      repositoryOwner: "acme",
      repositoryOwnerId: "456",
      repositoryName: "tasks",
      repositoryId: "123",
    });
    expect(
      RepositoryFormSchema.parse({
        intent: "repository",
        repositoryOwner: "acme",
        repositoryName: "tasks",
      })
    ).toMatchObject({ repositoryOwnerId: undefined, repositoryId: undefined });
    for (const value of ["acme@", "acme@not-an-id", "acme@123@456"]) {
      expect(
        RepositoryFormSchema.safeParse({
          intent: "repository",
          repositoryOwner: value,
          repositoryName: "tasks",
        }).success
      ).toBe(false);
    }
  });

  // Catches: accepting decoded JWTs without signature/issuer/audience/lifetime checks or losing extra signed claims.
  it("verifies GitHub identity before authorizing its claims", async () => {
    const verified = await verifyGithubDeployToken(await sign({ actor: "deploy-bot" }), jwks);
    expect(matchesTrustedDeploy(repository, grant, verified)).toBe(true);
    const actorRestricted = { ...grant, additionalClaims: { actor: ["deploy-bot"] } };
    expect(matchesTrustedDeploy(repository, actorRestricted, verified)).toBe(true);
    expect(
      matchesTrustedDeploy(repository, actorRestricted, { ...verified, actor: "someone-else" })
    ).toBe(false);
    for (const override of [
      { iss: "https://attacker.example" },
      { aud: "another-service" },
      { exp: 1 },
      { iat: 1 },
      { nbf: Math.floor(Date.now() / 1000) + 300 },
    ]) {
      await expect(verifyGithubDeployToken(await sign(override), jwks)).rejects.toThrow();
    }
    const attacker = await generateKeyPair("RS256");
    const forged = await new SignJWT({ ...claims, aud: TRUSTED_DEPLOY_AUDIENCE })
      .setProtectedHeader({ alg: "RS256", kid: "github" })
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("5m")
      .sign(attacker.privateKey);
    await expect(verifyGithubDeployToken(forged, jwks)).rejects.toThrow();
  });

  // Catches: names overriding immutable IDs, or a repository transfer retaining its old grant.
  it("pins both repository and owner, with name checks only when IDs are absent", () => {
    expect(matchesTrustedDeploy(repository, grant, { ...claims, repository_id: "999" })).toBe(
      false
    );
    expect(matchesTrustedDeploy(repository, grant, { ...claims, repository_owner_id: "999" })).toBe(
      false
    );
    expect(matchesTrustedDeploy(repository, grant, { ...claims, repository: "acme/renamed" })).toBe(
      true
    );
    const namesOnly = { ...repository, repositoryId: null, repositoryOwnerId: null };
    expect(matchesTrustedDeploy(namesOnly, grant, claims)).toBe(true);
    expect(
      matchesTrustedDeploy(namesOnly, grant, { ...claims, repository: "attacker/tasks" })
    ).toBe(false);
  });

  // Catches: scopes or additional claims broadening each other, or malformed stored conditions becoming allow-all.
  it("matches scope and every additional claim and fails closed on invalid settings", () => {
    expect(matchesTrustedDeploy(repository, grant, { ...claims, ref: "refs/heads/other" })).toBe(
      false
    );
    expect(matchesTrustedDeploy(repository, grant, { ...claims, environment: undefined })).toBe(
      false
    );
    const tag = { ...grant, scope: "TAG", scopeValue: "v1.0.*", additionalClaims: {} };
    expect(matchesTrustedDeploy(repository, tag, { ...claims, ref: "refs/tags/v1.0.2" })).toBe(
      true
    );
    expect(matchesTrustedDeploy(repository, tag, { ...claims, ref: "refs/tags/v1x0x2" })).toBe(
      false
    );
    for (const [scopeValue, branch, allowed] of [
      ["a*a", "a", false],
      ["*ab*bc", "abc", false],
      ["*ab*bc", "abbc", true],
      ["a**b", "ab", true],
      ["release/*", "release/sub/branch", true],
    ] as const) {
      expect(
        matchesTrustedDeploy(
          repository,
          { ...grant, scopeValue },
          {
            ...claims,
            ref: `refs/heads/${branch}`,
          }
        )
      ).toBe(allowed);
    }
    const environment = {
      ...grant,
      scope: "ENVIRONMENT",
      scopeValue: "production",
      additionalClaims: {},
    };
    expect(
      matchesTrustedDeploy(repository, environment, { ...claims, ref: "refs/heads/other" })
    ).toBe(true);
    expect(
      matchesTrustedDeploy(repository, environment, { ...claims, environment: "staging" })
    ).toBe(false);
    for (const invalid of [
      { scope: "UNKNOWN" },
      { scopeValue: null },
      { scope: "ANY", scopeValue: undefined },
      { additionalClaims: undefined },
      { additionalClaims: { actor: [] } },
      { additionalClaims: Object.fromEntries([["__proto__", ["anything"]]]) },
    ]) {
      expect(matchesTrustedDeploy(repository, { ...grant, ...invalid }, claims)).toBe(false);
    }
    expect(matchesTrustedDeploy(repository, { ...grant, enabled: false }, claims)).toBe(false);
  });

  // Catches: valid wildcard policies blocking the webapp event loop on an adversarial ref.
  it("bounds repeated-wildcard matching for both branches and tags", async () => {
    const cases = [
      { scopeValue: "a*".repeat(24) + "b", ref: "a".repeat(64) + "c", expected: false },
      { scopeValue: "a*".repeat(24) + "b*", ref: "a".repeat(64) + "c", expected: false },
      { scopeValue: "a*".repeat(24) + "b*", ref: "a".repeat(64) + "b", expected: true },
    ];
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { createRequire } = require("node:module");
      const localRequire = createRequire(workerData.policyPath);
      localRequire("tsx/cjs");
      const { matchesTrustedDeploy } = localRequire(workerData.policyPath);
      parentPort.once("message", () => {
        const results = ["BRANCH", "TAG"].flatMap(scope => workerData.cases.map(test =>
          matchesTrustedDeploy(workerData.repository, {
            ...workerData.grant, scope, scopeValue: test.scopeValue,
          }, {
            ...workerData.claims,
            ref: "refs/" + (scope === "BRANCH" ? "heads" : "tags") + "/" + test.ref,
          })
        ));
        parentPort.postMessage(results);
      });
      parentPort.postMessage("ready");
    `,
      {
        eval: true,
        workerData: {
          policyPath: fileURLToPath(
            new URL("../app/services/trustedDeploys/policy.ts", import.meta.url)
          ),
          repository,
          grant,
          claims,
          cases,
        },
      }
    );
    try {
      const startupTimeoutMs = 10_000;
      const matchTimeoutMs = 5_000;
      await once(worker, "message", { signal: AbortSignal.timeout(startupTimeoutMs) });
      const result = once(worker, "message", { signal: AbortSignal.timeout(matchTimeoutMs) });
      worker.postMessage("match");
      const [matches] = await result;
      expect(matches).toEqual(["BRANCH", "TAG"].flatMap(() => cases.map((test) => test.expected)));
    } finally {
      await worker.terminate();
    }
  }, 20_000);

  // Catches: Preview requiring a PR opt-in, claims lifting event restrictions, or pull_request_target reaching Preview.
  it("allows normal Preview PRs by default and uses claims only to narrow access", () => {
    const preview = {
      ...grant,
      environmentType: "PREVIEW" as const,
      scope: "ANY",
      scopeValue: null,
      additionalClaims: {},
    };
    const pr = { ...claims, event_name: "pull_request", ref: "refs/pull/123/merge" };
    expect(matchesTrustedDeploy(repository, preview, pr)).toBe(true);
    expect(matchesTrustedDeploy(repository, preview, claims)).toBe(true);
    expect(
      matchesTrustedDeploy(repository, preview, { ...claims, event_name: "workflow_dispatch" })
    ).toBe(true);
    for (const event_name of ["pull_request_target", "pull_request_review"]) {
      expect(
        matchesTrustedDeploy(
          repository,
          { ...preview, additionalClaims: { event_name: [event_name] } },
          { ...pr, event_name }
        )
      ).toBe(false);
    }
    expect(
      matchesTrustedDeploy(
        repository,
        { ...preview, additionalClaims: { event_name: ["push"] } },
        pr
      )
    ).toBe(false);
    expect(
      matchesTrustedDeploy(repository, { ...preview, scope: "BRANCH", scopeValue: "main" }, pr)
    ).toBe(false);
    for (const environmentType of ["STAGING", "PRODUCTION"] as const) {
      expect(
        matchesTrustedDeploy(
          repository,
          { ...preview, environmentType, additionalClaims: { event_name: ["pull_request"] } },
          pr
        )
      ).toBe(false);
    }
  });

  // Catches: form conversion dropping conditions, treating values as wildcards, or accepting empty claim rows.
  it("validates the scope form and converts only comma-separated claim values", () => {
    const input = EnvironmentFormSchema.parse({
      intent: "environment",
      repositoryUpdatedAt: "2026-11-06T00:00:00.000Z",
      scope: "BRANCH",
      scopeValue: "main",
      additionalClaims: [{ name: "event_name", values: "push, workflow_dispatch" }],
    });
    const policy = publishingPolicyFromForm(input);
    expect(matchesTrustedDeploy(repository, { ...grant, ...policy }, claims)).toBe(true);
    expect(
      matchesTrustedDeploy(
        repository,
        { ...grant, ...policy },
        { ...claims, ref: "refs/heads/other" }
      )
    ).toBe(false);
    expect(
      matchesTrustedDeploy(
        repository,
        { ...grant, ...policy },
        { ...claims, event_name: "release" }
      )
    ).toBe(false);
    expect(
      EnvironmentFormSchema.safeParse({ ...input, scopeValue: "refs/heads/main" }).success
    ).toBe(false);
    for (const additionalClaims of [
      [{ name: "", values: "" }],
      [{ name: " ", values: " , " }],
      [{ name: "event_name", values: "" }],
      [{ name: "", values: "push" }],
      [{ name: "__proto__", values: "anything" }],
      [
        { name: "event_name", values: "push" },
        { name: "event_name", values: "pull_request" },
      ],
    ]) {
      expect(EnvironmentFormSchema.safeParse({ ...input, additionalClaims }).success).toBe(false);
    }
    const formData = new FormData();
    formData.set("intent", "environment");
    formData.set("repositoryUpdatedAt", input.repositoryUpdatedAt);
    formData.set("scope", "ANY");
    formData.set("additionalClaims[0].name", "");
    formData.set("additionalClaims[0].values", "");
    expect(parseWithZod(formData, { schema: EnvironmentFormSchema }).status).toBe("error");
  });

  // Catches: a trusted submit request injecting builder privileges or switching to a local/bundle build.
  it("rejects build-server-only controls and workspace escapes supplied by the caller", () => {
    const submission = {
      projectRef: "proj_test",
      env: "prod",
      artifactKey: "deployments/source.tar.gz",
    };
    expect(SubmitTrustedDeployRequest.safeParse(submission).success).toBe(true);
    for (const extra of [
      { fromBundle: true },
      { isNativeBuild: false },
      { buildEnvVars: { SECRET: "value" } },
      { skipEnqueue: true },
      { userId: "someone" },
      { initialStatus: "BUILDING" },
      { configFilePath: "../trigger.config.ts" },
      { configFilePath: "/trigger.config.ts" },
      { configFilePath: "..\\trigger.config.ts" },
    ]) {
      expect(SubmitTrustedDeployRequest.safeParse({ ...submission, ...extra }).success).toBe(false);
    }
  });
});
