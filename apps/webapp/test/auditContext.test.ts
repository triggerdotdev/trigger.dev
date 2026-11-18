import { postgresTest } from "@internal/testcontainers";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HostBearerAuthResult } from "@trigger.dev/rbac";
import {
  getRequestAuditContext,
  noteBearerAuthentication,
  noteLegacyApiKeyAuthentication,
  noteOrganizationAccessTokenAuthentication,
  notePersonalAccessTokenAuthentication,
  noteSessionAuthentication,
} from "~/services/auditLogs/auditContext.server";
import { authenticateBearerWithTelemetry } from "~/services/authTelemetry.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { signPublicJwtActor } from "~/services/publicJwtActor.server";
import { publicTokenSecret } from "~/services/publicTokenSubject.server";
import { generateAdditionalApiKey } from "~/utils/apiKeys";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const CLIENT_IP = "203.0.113.7";

function apiRequest(token: string, headers: Record<string, string> = {}) {
  return new Request("https://api.trigger.dev/api/v1/projects/proj/envvars/prod", {
    headers: {
      Authorization: `Bearer ${token}`,
      // The load balancer appends the real client address last; earlier hops are client-supplied.
      "x-forwarded-for": `198.51.100.1, ${CLIENT_IP}`,
      "user-agent": "trigger.dev-sdk/4.0.0",
      ...headers,
    },
  });
}

/** Runs `fn` the way server.ts runs a request, then returns the audit context it left behind. */
async function inRequest(fn: () => Promise<unknown>) {
  return runWithHttpContext(
    {
      requestId: "req_test",
      path: "/api/v1/test",
      host: "api.trigger.dev",
      method: "GET",
      abortController: new AbortController(),
    },
    async () => {
      await fn();
      return getRequestAuditContext(new Date("2026-11-09T00:00:00Z"));
    }
  );
}

function controllerFor(prisma: PrismaClient) {
  return plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
}

async function createProductionEnvironment(prisma: PrismaClient) {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const apiKey = `tr_prod_${uniqueId("root").replace(/-/g, "")}`;
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    apiKey,
  });
  return { organization, project, user, environment, apiKey };
}

describe("request audit context from bearer authentication", () => {
  postgresTest(
    "identifies a root key by its environment and last 4, without the key itself",
    async ({ prisma }) => {
      const { environment, apiKey } = await createProductionEnvironment(prisma);

      const context = await inRequest(() =>
        authenticateBearerWithTelemetry(apiRequest(apiKey), {}, controllerFor(prisma))
      );

      expect(context).toEqual({
        occurredAt: new Date("2026-11-09T00:00:00Z"),
        actor: { type: "api_key", id: environment.id },
        credential: {
          kind: "root_api_key",
          id: environment.id,
          last4: apiKey.slice(-4),
          fingerprintId: null,
        },
        onBehalfOf: null,
        source: "api",
        endpoint: { ip: CLIENT_IP, userAgent: "trigger.dev-sdk/4.0.0" },
        origin: null,
        requestId: "req_test",
      });
      expect(JSON.stringify(context)).not.toContain(apiKey);
    }
  );

  postgresTest("attributes a branch request to its parent's root key", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const parentApiKey = `tr_preview_${uniqueId("root").replace(/-/g, "")}`;
    const parent = await prisma.runtimeEnvironment.create({
      data: {
        slug: "preview",
        type: "PREVIEW",
        apiKey: parentApiKey,
        pkApiKey: uniqueId("pk"),
        shortcode: uniqueId("sc"),
        projectId: project.id,
        organizationId: organization.id,
        isBranchableEnvironment: true,
      },
    });
    const branch = await prisma.runtimeEnvironment.create({
      data: {
        slug: uniqueId("branch"),
        type: "PREVIEW",
        apiKey: uniqueId("tr_branch"),
        pkApiKey: uniqueId("pk"),
        shortcode: uniqueId("sc"),
        projectId: project.id,
        organizationId: organization.id,
        parentEnvironmentId: parent.id,
        branchName: "feature-x",
      },
    });

    let authenticatedEnvironmentId: string | undefined;
    const context = await inRequest(async () => {
      const result = await authenticateBearerWithTelemetry(
        apiRequest(parentApiKey, { "x-trigger-branch": "feature-x" }),
        {},
        controllerFor(prisma)
      );
      authenticatedEnvironmentId = result.ok ? result.environment.id : undefined;
    });

    expect(authenticatedEnvironmentId).toBe(branch.id);
    expect(context.credential).toEqual({
      kind: "root_api_key",
      id: parent.id,
      last4: parentApiKey.slice(-4),
      fingerprintId: null,
    });
  });

  postgresTest(
    "keeps the rotated key's last 4 while it works in its grace window",
    async ({ prisma }) => {
      const { environment } = await createProductionEnvironment(prisma);
      const rotatedApiKey = `tr_prod_${uniqueId("old").replace(/-/g, "")}`;
      await prisma.revokedApiKey.create({
        data: {
          apiKey: rotatedApiKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const context = await inRequest(() =>
        authenticateBearerWithTelemetry(apiRequest(rotatedApiKey), {}, controllerFor(prisma))
      );

      expect(context.credential).toEqual({
        kind: "root_api_key",
        id: environment.id,
        last4: rotatedApiKey.slice(-4),
        fingerprintId: null,
      });
    }
  );

  postgresTest("identifies an additional key by its row id", async ({ prisma }) => {
    const { environment, user } = await createProductionEnvironment(prisma);
    const additionalApiKey = generateAdditionalApiKey("PRODUCTION").apiKey;
    const row = await prisma.apiKey.create({
      data: {
        name: "Integration",
        keyHash: createHash("sha256").update(additionalApiKey).digest("hex"),
        lastFour: additionalApiKey.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        scopes: ["admin"],
      },
    });

    const context = await inRequest(() =>
      authenticateBearerWithTelemetry(
        apiRequest(additionalApiKey, { "x-trigger-source": "cli" }),
        {},
        controllerFor(prisma)
      )
    );

    expect(context.actor).toEqual({ type: "api_key", id: row.id });
    expect(context.credential).toEqual({
      kind: "additional_api_key",
      id: row.id,
      last4: additionalApiKey.slice(-4),
      fingerprintId: null,
    });
    expect(context.source).toBe("cli");
  });

  postgresTest(
    "attributes a public JWT to the root key that signed it, and its acting user",
    async ({ prisma }) => {
      const { environment, apiKey, user } = await createProductionEnvironment(prisma);
      const plainToken = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
      });
      // As the exchange route mints it: the server signs the user onto the token.
      const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
      // The same secret the verifier reads, so the two can't diverge.
      const sig = signPublicJwtActor(
        publicTokenSecret(),
        { sub: user.id },
        { environmentId: environment.id, expiresAt, scopes: ["read:runs"] }
      );
      const delegatedToken = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: ["read:runs"],
          act: { sub: user.id, sig },
        },
        expirationTime: expiresAt,
      });
      // Catches: a user written into a JWT signed with the root key alone becoming the actor.
      const forgedToken = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"], act: { sub: user.id } },
        expirationTime: expiresAt,
      });

      const plain = await inRequest(() =>
        authenticateBearerWithTelemetry(
          apiRequest(plainToken),
          { allowJWT: true },
          controllerFor(prisma)
        )
      );
      const delegated = await inRequest(() =>
        authenticateBearerWithTelemetry(
          apiRequest(delegatedToken),
          { allowJWT: true },
          controllerFor(prisma)
        )
      );

      const forged = await inRequest(() =>
        authenticateBearerWithTelemetry(
          apiRequest(forgedToken),
          { allowJWT: true },
          controllerFor(prisma)
        )
      );

      const signedByRootKey = {
        kind: "public_jwt",
        id: environment.id,
        last4: apiKey.slice(-4),
        fingerprintId: null,
      };
      expect(plain.actor).toEqual({ type: "api_key", id: environment.id });
      expect(plain.credential).toEqual(signedByRootKey);
      expect(delegated.actor).toEqual({ type: "user", id: user.id });
      expect(delegated.credential).toEqual(signedByRootKey);
      expect(forged.actor).toEqual({ type: "api_key", id: environment.id });
      expect(forged.credential).toEqual(signedByRootKey);
    }
  );

  postgresTest(
    "attributes a public JWT signed by a rotated key to that key",
    async ({ prisma }) => {
      const { environment } = await createProductionEnvironment(prisma);
      const rotatedApiKey = `tr_prod_${uniqueId("old").replace(/-/g, "")}`;
      await prisma.revokedApiKey.create({
        data: {
          apiKey: rotatedApiKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const token = await generateJWT({
        secretKey: rotatedApiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
      });

      const context = await inRequest(() =>
        authenticateBearerWithTelemetry(
          apiRequest(token),
          { allowJWT: true },
          controllerFor(prisma)
        )
      );

      expect(context.credential?.last4).toBe(rotatedApiKey.slice(-4));
    }
  );

  postgresTest(
    "leaves the context empty when a JWT's subject names an environment it wasn't signed for",
    async ({ prisma }) => {
      const { environment } = await createProductionEnvironment(prisma);
      const forged = await generateJWT({
        secretKey: "tr_prod_not_this_environments_key",
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
      });

      let ok: boolean | undefined;
      const context = await inRequest(async () => {
        const result = await authenticateBearerWithTelemetry(
          apiRequest(forged),
          { allowJWT: true },
          controllerFor(prisma)
        );
        ok = result.ok;
      });

      expect(ok).toBe(false);
      expect(context.actor).toBeNull();
      expect(context.credential).toBeNull();
    }
  );

  postgresTest("leaves the context empty for an unknown key", async ({ prisma }) => {
    const context = await inRequest(() =>
      authenticateBearerWithTelemetry(
        apiRequest("tr_prod_unknownunknownunknown"),
        {},
        controllerFor(prisma)
      )
    );

    expect(context.actor).toBeNull();
    expect(context.credential).toBeNull();
    expect(context.endpoint).toBeNull();
    expect(context.requestId).toBe("req_test");
  });
});

describe("request audit context from other auth functions", () => {
  it("records the impersonated user as the actor and the staff member as on behalf of", async () => {
    const context = await inRequest(async () =>
      noteSessionAuthentication(apiRequest(""), {
        userId: "user_customer",
        impersonatorUserId: "user_staff",
      })
    );

    expect(context.actor).toEqual({ type: "user", id: "user_customer" });
    expect(context.onBehalfOf).toEqual({ userId: "user_staff" });
    expect(context.source).toBe("staff");
    expect(context.credential).toBeNull();
  });

  it("records a plain dashboard session as the user", async () => {
    const context = await inRequest(async () =>
      noteSessionAuthentication(apiRequest(""), { userId: "user_1" })
    );

    expect(context.actor).toEqual({ type: "user", id: "user_1" });
    expect(context.onBehalfOf).toBeNull();
    expect(context.source).toBe("dashboard");
  });

  it("records a personal access token as its user, and a user-actor token by its source token", async () => {
    const pat = "tr_pat_abcdefghijklmnopqrstuvwxyz0123456789";
    const patContext = await inRequest(async () =>
      notePersonalAccessTokenAuthentication(apiRequest(pat), { userId: "user_1", tokenId: "pat_1" })
    );
    const userActorContext = await inRequest(async () =>
      notePersonalAccessTokenAuthentication(apiRequest("tr_uat_signed.token.value"), {
        userId: "user_1",
        userActor: { pat: "pat_source" },
      })
    );

    expect(patContext.actor).toEqual({ type: "user", id: "user_1" });
    expect(patContext.credential).toEqual({
      kind: "pat",
      id: "pat_1",
      last4: "6789",
      fingerprintId: null,
    });
    expect(JSON.stringify(patContext)).not.toContain(pat);
    expect(userActorContext.credential).toEqual({
      kind: "pat",
      id: "pat_source",
      last4: null,
      fingerprintId: null,
    });
  });

  /** Catches: a user-actor token minted from a session shown as a PAT the user doesn't have. */
  it("records no credential for a user-actor token minted without a personal access token", async () => {
    const context = await inRequest(async () =>
      notePersonalAccessTokenAuthentication(apiRequest("tr_uat_signed.token.value"), {
        userId: "user_1",
        userActor: {},
      })
    );

    expect(context.actor).toEqual({ type: "user", id: "user_1" });
    expect(context.credential).toBeNull();
  });

  it("records an organization access token as the actor", async () => {
    const context = await inRequest(async () =>
      noteOrganizationAccessTokenAuthentication(
        apiRequest("tr_oat_abcdefghijklmnopqrstuvwxyz0123456789"),
        { tokenId: "oat_1" }
      )
    );

    expect(context.actor).toEqual({ type: "oat", id: "oat_1" });
    expect(context.credential).toMatchObject({ kind: "oat", id: "oat_1", last4: "6789" });
  });

  it("identifies root keys and JWTs on the legacy API-key path", async () => {
    const environment = { id: "env_branch", parentEnvironmentId: "env_parent" };
    const rootKey = "tr_preview_abcdefghijklmnop1234";

    const root = await inRequest(async () =>
      noteLegacyApiKeyAuthentication(apiRequest(rootKey), {
        ok: true,
        apiKey: rootKey,
        type: "PRIVATE",
        environment,
      })
    );
    const jwt = await inRequest(async () =>
      noteLegacyApiKeyAuthentication(apiRequest("eyJ.jwt.value"), {
        ok: true,
        apiKey: "eyJ.jwt.value",
        type: "PUBLIC_JWT",
        environment,
        jwtSigningKeyLast4: "wxyz",
      })
    );

    expect(root.credential).toEqual({
      kind: "root_api_key",
      id: "env_parent",
      last4: "1234",
      fingerprintId: null,
    });
    expect(jwt.credential).toEqual({
      kind: "public_jwt",
      id: "env_parent",
      last4: "wxyz",
      fingerprintId: null,
    });
  });

  // Catches: the legacy path trusting a user that only the root key's holder wrote into the JWT.
  it("takes a legacy public JWT's acting user only when the server signed it", async () => {
    const environment = { id: "env_1", parentEnvironmentId: null };
    const noteJwt = (verified: boolean) =>
      inRequest(async () =>
        noteLegacyApiKeyAuthentication(apiRequest("eyJ.jwt.value"), {
          ok: true,
          apiKey: "eyJ.jwt.value",
          type: "PUBLIC_JWT",
          environment,
          actor: { sub: "user_1", verified },
        })
      );

    expect((await noteJwt(true)).actor).toEqual({ type: "user", id: "user_1" });
    expect((await noteJwt(false)).actor).toEqual({ type: "api_key", id: "env_1" });
  });

  /** Catches: the run id repeated outside the actor, as the credential id or as our infra acting. */
  it("records task code using a run token as that run", async () => {
    const runTokenAuthentication = {
      ok: true,
      environment: { id: "env_1", parentEnvironmentId: null },
      subject: {
        type: "runToken",
        runId: "run_abc123",
        environmentId: "env_1",
        organizationId: "org_1",
        projectId: "proj_1",
      },
      ability: { can: () => true, canSuper: () => false },
      resolution: { credentialKind: "run_token", lookupPath: "run_token" },
    } as unknown as HostBearerAuthResult;

    const context = await inRequest(async () =>
      noteBearerAuthentication(apiRequest("eyJ.run.token"), runTokenAuthentication)
    );

    expect(context.actor).toEqual({ type: "run", id: "run_abc123" });
    expect(context.credential).toEqual({
      kind: "run_token",
      id: null,
      last4: null,
      fingerprintId: null,
    });
    expect(context.source).toBe("run");
    expect(context.origin).toBeNull();
  });

  // Catches: a caller relabelling its changes as task code by sending the worker header, so a
  // reviewer filtering out runs would skip them. Only a run token makes the source "run".
  it("ignores the worker header when deciding the source", async () => {
    const context = await inRequest(async () =>
      notePersonalAccessTokenAuthentication(
        apiRequest("tr_pat_abcdefghijklmnopqrstuvwxyz0123456789", { "x-trigger-worker": "true" }),
        { userId: "user_1", tokenId: "pat_1" }
      )
    );

    expect(context.source).toBe("api");
  });

  it("does nothing outside a request and never throws", () => {
    expect(() => noteSessionAuthentication(apiRequest(""), { userId: "user_1" })).not.toThrow();
    expect(() =>
      noteLegacyApiKeyAuthentication(apiRequest(""), {
        ok: true,
        apiKey: "tr_x",
        type: "PRIVATE",
        // Malformed input from a misbehaving caller.
        environment: null as unknown as { id: string; parentEnvironmentId: string | null },
      })
    ).not.toThrow();

    expect(getRequestAuditContext(new Date(0))).toEqual({
      occurredAt: new Date(0),
      actor: null,
      credential: null,
      onBehalfOf: null,
      source: null,
      endpoint: null,
      origin: null,
      requestId: null,
    });
  });

  it("swallows errors inside a request too", async () => {
    const context = await inRequest(async () =>
      noteLegacyApiKeyAuthentication(apiRequest("tr_x"), {
        ok: true,
        apiKey: "tr_x",
        type: "PRIVATE",
        environment: null as unknown as { id: string; parentEnvironmentId: string | null },
      })
    );

    expect(context.actor).toBeNull();
  });
});
