import { extractJWTSub, isPublicJWT } from "@trigger.dev/core/v3/jwt";
import type { PrismaClient } from "@trigger.dev/database";
import {
  scopesGrantFullAccess,
  type BearerAuthResult,
  type RoleBaseAccessController,
} from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import { buildJwtAbility } from "./ability.js";
import loader, { resolveJwtSigningKey } from "./index.js";

type AuthSuccess = Extract<BearerAuthResult, { ok: true }>;

type LazyControllerInternals = {
  _init: Promise<RoleBaseAccessController>;
  _hostCredentialResolver: {
    authenticate: RoleBaseAccessController["authenticateBearer"];
  };
};

const prismaPlaceholder = {} as PrismaClient;
const environment = {
  id: "env_123",
  organizationId: "org_123",
  projectId: "proj_123",
  parentEnvironment: null,
  parentEnvironmentId: null,
} as unknown as AuthSuccess["environment"];

function installPlugin(
  plugin: RoleBaseAccessController,
  hostAuthenticate: RoleBaseAccessController["authenticateBearer"]
) {
  const controller = loader.create(prismaPlaceholder, { forceFallback: true });
  const internals = controller as unknown as LazyControllerInternals;
  internals._init = Promise.resolve(plugin);
  internals._hostCredentialResolver = { authenticate: hostAuthenticate };
  return controller;
}

function additionalKeyResult(scopes: string[]): AuthSuccess {
  return {
    ok: true,
    environment,
    subject: {
      type: "apiKey",
      apiKeyId: "key_123",
      restricted: !scopesGrantFullAccess(scopes),
      organizationId: environment.organizationId,
      projectId: environment.projectId,
    },
    ability: buildJwtAbility(scopes),
  };
}

function publicJwtResult(): AuthSuccess {
  return {
    ok: true,
    environment,
    subject: {
      type: "publicJWT",
      environmentId: environment.id,
      organizationId: environment.organizationId,
      projectId: environment.projectId,
    },
    ability: buildJwtAbility(["read:runs"]),
  };
}

function publicJwt(payload: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("API-key policy controller composition", () => {
  it("routes public JWTs directly to the host without calling the plugin authenticator", async () => {
    const pluginAuthenticate = vi.fn();
    const hostAuthenticate = vi.fn(async () => publicJwtResult());
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      authenticateBearer: pluginAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(plugin, hostAuthenticate);
    const token = publicJwt({ pub: true, sub: environment.id });

    const result = await controller.authenticateBearer(
      new Request("https://api.trigger.dev/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { allowJWT: true }
    );

    expect(result.ok).toBe(true);
    expect(hostAuthenticate).toHaveBeenCalledOnce();
    expect(pluginAuthenticate).not.toHaveBeenCalled();
  });

  it("uses the scoped host result unchanged when plugin auth falls back to an additional key", async () => {
    const pluginAuthenticate = vi.fn(async () => ({
      ok: false as const,
      status: 401 as const,
      error: "Invalid API key",
    }));
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      authenticateBearer: pluginAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(
      plugin,
      vi.fn(async () => additionalKeyResult(["write:tasks:send-email"]))
    );

    const result = await controller.authenticateBearer(
      new Request("https://api.trigger.dev/test", {
        headers: { Authorization: "Bearer tr_additional" },
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toMatchObject({ type: "apiKey", restricted: true });
    expect(result.ability.can("trigger", { type: "tasks", id: "send-email" })).toBe(true);
    expect(result.ability.can("trigger", { type: "tasks", id: "other-task" })).toBe(false);
    expect(result.ability.can("read", { type: "runs" })).toBe(false);
  });

  it("delegates API-key policy catalogue, preparation, and description", async () => {
    const presets = vi.fn(async () => []);
    const prepare = vi.fn(async () => ({
      ok: true as const,
      policy: { presetId: "FULL_ACCESS", scopes: ["admin"] },
    }));
    const describePolicy = vi.fn(async () => ({ taskIdentifiers: ["send-email"] }));
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      apiKeyPresets: presets,
      prepareApiKeyPolicy: prepare,
      describeApiKeyPolicy: describePolicy,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(plugin, vi.fn());
    const prepareParams = { organizationId: "org_123", presetId: "FULL_ACCESS" };
    const policy = { presetId: "TASKS", scopes: ["trigger:tasks:send-email"] };

    await controller.apiKeyPresets("org_123");
    await controller.prepareApiKeyPolicy(prepareParams);
    await controller.describeApiKeyPolicy(policy);

    expect(presets).toHaveBeenCalledWith("org_123");
    expect(prepare).toHaveBeenCalledWith(prepareParams);
    expect(describePolicy).toHaveBeenCalledWith(policy);
  });
});

describe("API-key policy fallback", () => {
  it("prepares explicit standalone full access and exposes no preset catalogue", async () => {
    const controller = loader.create(prismaPlaceholder, { forceFallback: true });

    await expect(controller.apiKeyPresets("org_123")).resolves.toBeNull();
    await expect(
      controller.prepareApiKeyPolicy({ organizationId: "org_123", presetId: "FULL_ACCESS" })
    ).resolves.toEqual({
      ok: true,
      policy: { presetId: null, scopes: ["admin"] },
    });
    await expect(
      controller.describeApiKeyPolicy({ presetId: null, scopes: ["admin"] })
    ).resolves.toEqual({});
  });

  it("rejects restricted presets and task input without a plugin", async () => {
    const controller = loader.create(prismaPlaceholder, { forceFallback: true });
    const unavailable = { ok: false, error: "API key access presets are not available" };

    // Anything other than full access is a restricted key, which needs the plugin.
    await expect(
      controller.prepareApiKeyPolicy({ organizationId: "org_123", presetId: "TRIGGER_ONLY" })
    ).resolves.toEqual(unavailable);
    await expect(
      controller.prepareApiKeyPolicy({
        organizationId: "org_123",
        presetId: "FULL_ACCESS",
        taskIdentifiers: ["send-email"],
      })
    ).resolves.toEqual(unavailable);
  });
});

describe("scope policy helpers", () => {
  it("recognizes only exact bare admin as full access", () => {
    expect(scopesGrantFullAccess(["admin"])).toBe(true);
    expect(scopesGrantFullAccess(["read:runs", "admin"])).toBe(true);
    expect(scopesGrantFullAccess([])).toBe(false);
    expect(scopesGrantFullAccess(["admin:runs"])).toBe(false);
    expect(scopesGrantFullAccess(["*:all"])).toBe(false);
  });
});

describe("JWT host helpers", () => {
  it("recognizes public JWTs and extracts their subject", () => {
    const token = publicJwt({ pub: true, sub: "env_123" });
    expect(isPublicJWT(token)).toBe(true);
    expect(extractJWTSub(token)).toBe("env_123");
    expect(isPublicJWT("not-a-jwt")).toBe(false);
    expect(extractJWTSub("not-a-jwt")).toBeUndefined();
  });

  it("uses the parent key as branch JWT-signing material", () => {
    expect(resolveJwtSigningKey({ apiKey: "root" })).toBe("root");
    expect(resolveJwtSigningKey({ apiKey: "child", parentEnvironment: { apiKey: "parent" } })).toBe(
      "parent"
    );
  });
});
