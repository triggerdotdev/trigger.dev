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
const ADDITIONAL_API_KEY = "tr_prod_sk_0123456789abcdefghijklmn";
const ROOT_API_KEY = "tr_prod_0123456789abcdefghijklmn";
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

function rootKeyResult(): AuthSuccess {
  return {
    ok: true,
    environment,
    subject: {
      type: "user",
      userId: "user_123",
      organizationId: environment.organizationId,
      projectId: environment.projectId,
    },
    ability: buildJwtAbility(["admin"]),
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

function bearerRequest(token: string) {
  return new Request("https://api.trigger.dev/test", {
    headers: { Authorization: `Bearer ${token}` },
  });
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

  it("routes valid additional keys directly to the host and preserves their scopes", async () => {
    const pluginAuthenticate = vi.fn();
    const hostAuthenticate = vi.fn(async () => additionalKeyResult(["write:tasks:send-email"]));
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      authenticateBearer: pluginAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(plugin, hostAuthenticate);

    const result = await controller.authenticateBearer(bearerRequest(ADDITIONAL_API_KEY));

    expect(result.ok).toBe(true);
    expect(hostAuthenticate).toHaveBeenCalledOnce();
    expect(pluginAuthenticate).not.toHaveBeenCalled();
    if (!result.ok) return;
    expect(result.subject).toMatchObject({ type: "apiKey", restricted: true });
    expect(result.ability.can("trigger", { type: "tasks", id: "send-email" })).toBe(true);
    expect(result.ability.can("trigger", { type: "tasks", id: "other-task" })).toBe(false);
    expect(result.ability.can("read", { type: "runs" })).toBe(false);
  });

  it("returns an unknown additional key's host 401 without calling the plugin", async () => {
    const hostFailure = {
      ok: false as const,
      status: 401 as const,
      error: "Invalid API key",
    };
    const pluginAuthenticate = vi.fn();
    const hostAuthenticate = vi.fn(async () => hostFailure);
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      authenticateBearer: pluginAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(plugin, hostAuthenticate);

    await expect(
      controller.authenticateBearer(bearerRequest(ADDITIONAL_API_KEY))
    ).resolves.toMatchObject(hostFailure);
    expect(hostAuthenticate).toHaveBeenCalledOnce();
    expect(pluginAuthenticate).not.toHaveBeenCalled();
  });

  it("routes current root keys to the plugin without calling the host", async () => {
    const pluginAuthenticate = vi.fn(async () => rootKeyResult());
    const hostAuthenticate = vi.fn();
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      authenticateBearer: pluginAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(plugin, hostAuthenticate);

    await expect(controller.authenticateBearer(bearerRequest(ROOT_API_KEY))).resolves.toMatchObject(
      {
        ok: true,
        subject: { type: "user" },
      }
    );
    expect(pluginAuthenticate).toHaveBeenCalledOnce();
    expect(hostAuthenticate).not.toHaveBeenCalled();
  });

  it.each([401, 403] as const)(
    "returns a plugin %s for root-shaped keys without calling the host",
    async (status) => {
      const pluginFailure = {
        ok: false as const,
        status,
        error: "Unauthorized",
      };
      const pluginAuthenticate = vi.fn(async () => pluginFailure);
      const hostAuthenticate = vi.fn();
      const plugin = {
        isUsingPlugin: vi.fn(async () => true),
        authenticateBearer: pluginAuthenticate,
      } as unknown as RoleBaseAccessController;
      const controller = installPlugin(plugin, hostAuthenticate);

      await expect(
        controller.authenticateBearer(bearerRequest(ROOT_API_KEY))
      ).resolves.toMatchObject(pluginFailure);
      expect(pluginAuthenticate).toHaveBeenCalledOnce();
      expect(hostAuthenticate).not.toHaveBeenCalled();
    }
  );

  it("fails closed when an additional-key host route resolves a non-apiKey subject", async () => {
    const pluginAuthenticate = vi.fn();
    const hostAuthenticate = vi.fn(async () => rootKeyResult());
    const plugin = {
      isUsingPlugin: vi.fn(async () => true),
      authenticateBearer: pluginAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(plugin, hostAuthenticate);

    await expect(
      controller.authenticateBearer(bearerRequest(ADDITIONAL_API_KEY))
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "Invalid API key",
    });
    expect(pluginAuthenticate).not.toHaveBeenCalled();
  });

  it("keeps additional-key authentication in the no-plugin fallback controller", async () => {
    const fallbackAuthenticate = vi.fn(async () => additionalKeyResult(["admin"]));
    const hostAuthenticate = vi.fn();
    const fallback = {
      isUsingPlugin: vi.fn(async () => false),
      authenticateBearer: fallbackAuthenticate,
    } as unknown as RoleBaseAccessController;
    const controller = installPlugin(fallback, hostAuthenticate);

    await expect(
      controller.authenticateBearer(bearerRequest(ADDITIONAL_API_KEY))
    ).resolves.toMatchObject({ ok: true, subject: { type: "apiKey" } });
    expect(fallbackAuthenticate).toHaveBeenCalledOnce();
    expect(hostAuthenticate).not.toHaveBeenCalled();
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
