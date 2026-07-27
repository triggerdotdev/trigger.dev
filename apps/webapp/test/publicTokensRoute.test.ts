import { postgresTest } from "@internal/testcontainers";
import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import type { PrismaClient } from "@trigger.dev/database";
import { buildJwtAbility } from "@trigger.dev/plugins";
import rbacPlugin, { type RbacAbility, type RoleBaseAccessController } from "@trigger.dev/rbac";
import { describe, expect, it } from "vitest";
import { handlePublicTokenRequest } from "~/services/publicTokens.server";
import { generateAdditionalApiKey, generateRootApiKey, hashApiKey } from "~/utils/apiKeys";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

function request(body: unknown, accessToken = "tr_prod_test", expirationTime?: string | number) {
  return new Request("https://api.trigger.dev/api/v1/auth/public-tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      expirationTime === undefined ? body : { ...(body as object), expirationTime }
    ),
  });
}

const environment = {
  id: "env_test",
  apiKey: "tr_prod_root_signing_secret",
  parentEnvironment: null,
};

const permissiveAbility: RbacAbility = {
  can: () => true,
  canSuper: () => false,
};

function controllerWithAbility(
  ability: RbacAbility,
  subject: "root" | "additional" = "additional"
) {
  return {
    async authenticateBearer() {
      return {
        ok: true as const,
        environment,
        subject:
          subject === "root"
            ? {
                type: "user" as const,
                userId: "user_test",
                organizationId: "org_test",
              }
            : {
                type: "apiKey" as const,
                apiKeyId: "key_test",
                restricted: ability !== permissiveAbility,
                organizationId: "org_test",
              },
        ability,
      };
    },
  } as unknown as Pick<RoleBaseAccessController, "authenticateBearer">;
}

async function responseJson(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

describe("POST /api/v1/auth/public-tokens", () => {
  it("lets root and unrestricted additional keys mint arbitrary scopes", async () => {
    for (const controller of [
      controllerWithAbility(permissiveAbility, "root"),
      controllerWithAbility(permissiveAbility, "additional"),
    ]) {
      const response = await handlePublicTokenRequest(
        request({ scopes: ["read:runs", "custom:resources:value"] }),
        controller
      );
      expect(response.status).toBe(200);

      const { token } = await responseJson(response);
      const validation = await validateJWT(token, environment.apiKey);
      expect(validation.ok).toBe(true);
      if (!validation.ok) continue;
      expect(validation.payload).toMatchObject({
        sub: environment.id,
        pub: true,
        scopes: ["read:runs", "custom:resources:value"],
      });
    }
  });

  it("allows restricted subsets and rejects excess scopes", async () => {
    const controller = controllerWithAbility(
      buildJwtAbility(["read:runs", "trigger:tasks:send-email"])
    );

    const allowed = await handlePublicTokenRequest(
      request({ scopes: ["read:runs:run_123", "trigger:tasks:send-email"] }),
      controller
    );
    expect(allowed.status).toBe(200);

    const denied = await handlePublicTokenRequest(
      request({ scopes: ["read:runs", "write:runs", "trigger:tasks"] }),
      controller
    );
    expect(denied.status).toBe(403);
    await expect(responseJson(denied)).resolves.toMatchObject({
      code: "scopes_exceed_key_access",
      deniedScopes: ["write:runs", "trigger:tasks"],
    });
  });

  it("rejects a type-level scope when the key only has per-id access", async () => {
    const response = await handlePublicTokenRequest(
      request({ scopes: ["trigger:tasks"] }),
      controllerWithAbility(buildJwtAbility(["trigger:tasks:send-email"]))
    );

    expect(response.status).toBe(403);
    await expect(responseJson(response)).resolves.toMatchObject({
      deniedScopes: ["trigger:tasks"],
    });
  });

  it("rejects empty scopes", async () => {
    const response = await handlePublicTokenRequest(
      request({ scopes: [] }),
      controllerWithAbility(permissiveAbility)
    );

    expect(response.status).toBe(400);
  });

  it("rejects expirations longer than 30 days", async () => {
    const response = await handlePublicTokenRequest(
      request({ scopes: ["read:runs"] }, undefined, "31d"),
      controllerWithAbility(permissiveAbility)
    );

    expect(response.status).toBe(400);
    await expect(responseJson(response)).resolves.toMatchObject({
      error: "Expiration time cannot exceed 30 days",
    });
  });

  it.each(["-5m", "5m ago"])("rejects an expiration in the past (%s)", async (expirationTime) => {
    const response = await handlePublicTokenRequest(
      request({ scopes: ["read:runs"] }, undefined, expirationTime),
      controllerWithAbility(permissiveAbility)
    );

    expect(response.status).toBe(400);
    await expect(responseJson(response)).resolves.toMatchObject({
      error: "Expiration time must be in the future",
    });
  });

  it("signs the exp it validated rather than re-parsing the input string", async () => {
    const before = Math.floor(Date.now() / 1000);
    const response = await handlePublicTokenRequest(
      request({ scopes: ["read:runs"] }, undefined, "10m"),
      controllerWithAbility(permissiveAbility)
    );

    expect(response.status).toBe(200);
    const { token } = (await responseJson(response)) as { token: string };
    const validation = await validateJWT(token, environment.apiKey);

    expect(validation.ok).toBe(true);
    // A single parse governs both the cap check and the claim.
    const exp = (validation as { payload: { exp: number } }).payload.exp;
    expect(exp).toBeGreaterThanOrEqual(before + 600);
    expect(exp).toBeLessThanOrEqual(before + 601);
  });

  it("does not allow a public JWT bearer to mint another token", async () => {
    const jwt = await generateJWT({
      secretKey: environment.apiKey,
      payload: { sub: environment.id, pub: true, scopes: ["read:runs"] },
      expirationTime: "15m",
    });
    const controller = {
      async authenticateBearer(_request: Request, options?: { allowJWT?: boolean }) {
        return options?.allowJWT
          ? ({
              ok: true,
              environment,
              subject: {
                type: "publicJWT",
                environmentId: environment.id,
                organizationId: "org_test",
              },
              ability: buildJwtAbility(["read:runs"]),
            } as const)
          : ({ ok: false, status: 401, error: "Invalid API key" } as const);
      },
    } as unknown as Pick<RoleBaseAccessController, "authenticateBearer">;

    const response = await handlePublicTokenRequest(
      request({ scopes: ["read:runs"] }, jwt),
      controller
    );

    expect(response.status).toBe(401);
  });
});

function makeController(prisma: PrismaClient) {
  return rbacPlugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
}

postgresTest(
  "minted tokens round-trip after the root key is rotated",
  async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const originalRootKey = generateRootApiKey("PRODUCTION").apiKey;
    const rotatedSigningKey = generateRootApiKey("PRODUCTION").apiKey;
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: uniqueId("env"),
        apiKey: originalRootKey,
        pkApiKey: uniqueId("pk"),
        shortcode: uniqueId("sc"),
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
        orgMemberId: orgMember.id,
      },
    });
    const additionalKey = generateAdditionalApiKey("PRODUCTION").apiKey;
    await prisma.apiKey.create({
      data: {
        name: "Token minter",
        keyHash: hashApiKey(additionalKey),
        lastFour: additionalKey.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: "READ_ONLY",
        scopes: ["read:runs"],
      },
    });
    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { apiKey: rotatedSigningKey },
    });

    const controller = makeController(prisma);
    const mintResponse = await handlePublicTokenRequest(
      request({ scopes: ["read:runs"], oneTimeUse: true }, additionalKey),
      controller
    );
    expect(mintResponse.status).toBe(200);
    const { token } = await responseJson(mintResponse);

    const authResult = await controller.authenticateBearer(
      new Request("https://api.trigger.dev/api/v1/runs", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { allowJWT: true }
    );

    expect(authResult.ok).toBe(true);
    if (!authResult.ok) return;
    expect(authResult.environment.id).toBe(environment.id);
    expect(authResult.jwt?.oneTimeUse).toBe(true);
    expect(authResult.ability.can("read", { type: "runs" })).toBe(true);
  },
  60_000
);
