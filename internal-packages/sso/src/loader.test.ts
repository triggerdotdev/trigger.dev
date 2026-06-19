import { describe, expect, it, vi } from "vitest";
import type {
  OrgSsoStatus,
  SsoController,
  SsoFlow,
  SsoPlugin,
  SsoProfile,
  SsoResolutionDecision,
  SsoRouteDecision,
} from "@trigger.dev/plugins";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import loader, { LazyController } from "./index.js";

// A minimal stub controller used in the "plugin found" test path. Only
// the methods the test cares about return useful values; the rest
// return permissive defaults.
function makeStubController(overrides: Partial<SsoController> = {}): SsoController {
  const stub: SsoController = {
    async isUsingPlugin() {
      return true;
    },
    getStatus(): ResultAsync<OrgSsoStatus, "internal"> {
      return okAsync({
        hasIdpOrg: true,
        enforced: false,
        jitProvisioningEnabled: true,
        jitDefaultRoleId: null,
        idpOrgId: "idp_stub",
        primaryConnectionId: null,
        domains: [],
        connections: [],
      });
    },
    generatePortalLink() {
      return okAsync({ url: "https://stub.example/portal" });
    },
    setEnforced() {
      return okAsync(undefined as void);
    },
    setJitProvisioningEnabled() {
      return okAsync(undefined as void);
    },
    setJitDefaultRole() {
      return okAsync(undefined as void);
    },
    updateConfig() {
      return okAsync(undefined as void);
    },
    decideRouteForEmail(): ResultAsync<SsoRouteDecision, "internal"> {
      return okAsync<SsoRouteDecision, "internal">({
        kind: "sso_required",
        idpOrgId: "idp_stub",
      });
    },
    beginAuthorization() {
      return okAsync({ url: "https://stub.example/auth" });
    },
    completeAuthorization() {
      return errAsync("connection_unknown" as const);
    },
    completeIdpInitiatedAuthorization() {
      return errAsync("connection_unknown" as const);
    },
    resolveSsoIdentity(): ResultAsync<SsoResolutionDecision, "feature_disabled"> {
      return errAsync("feature_disabled" as const);
    },
    attachSsoIdentity() {
      return errAsync("feature_disabled" as const);
    },
    evaluateJit() {
      return errAsync("feature_disabled" as const);
    },
    validateSession() {
      return okAsync({ valid: true });
    },
    verifyWebhook() {
      return errAsync("invalid_signature" as const);
    },
    processWebhookEvent() {
      return okAsync(undefined as void);
    },
    ...overrides,
  };
  return stub;
}

// Minimal Prisma stub. The fallback's only constructor work is to
// record the input; nothing else here touches the database.
const fakePrisma = {} as unknown as Parameters<typeof loader.create>[0];

describe("SSO LazyController", () => {
  describe("plugin missing (ERR_MODULE_NOT_FOUND on the plugin's own moduleName)", () => {
    it("falls back to the no-op implementation and reports isUsingPlugin=false", async () => {
      const importer = vi.fn(async (moduleName: string) => {
        const err = Object.assign(new Error(`Cannot find module '${moduleName}'`), {
          code: "ERR_MODULE_NOT_FOUND",
        });
        throw err;
      });

      const controller = new LazyController(fakePrisma, { importer });

      expect(await controller.isUsingPlugin()).toBe(false);
      const decision = await controller.decideRouteForEmail("anyone@example.com");
      expect(decision.isOk()).toBe(true);
      expect(decision._unsafeUnwrap()).toEqual({ kind: "no_sso" });
    });

    it("does not log to console.log unless SSO_LOG_FALLBACK=1", async () => {
      const previous = process.env.SSO_LOG_FALLBACK;
      delete process.env.SSO_LOG_FALLBACK;
      const importer = vi.fn(async (moduleName: string) => {
        const err = Object.assign(new Error(`Cannot find module '${moduleName}'`), {
          code: "ERR_MODULE_NOT_FOUND",
        });
        throw err;
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const controller = new LazyController(fakePrisma, { importer });
        await controller.isUsingPlugin();
        const fallbackLogs = logSpy.mock.calls.filter((args) =>
          args.some(
            (a) =>
              typeof a === "string" && a.includes("no plugin installed")
          )
        );
        expect(fallbackLogs.length).toBe(0);
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        if (previous === undefined) delete process.env.SSO_LOG_FALLBACK;
        else process.env.SSO_LOG_FALLBACK = previous;
      }
    });

    it("logs an info line when SSO_LOG_FALLBACK=1", async () => {
      const previous = process.env.SSO_LOG_FALLBACK;
      process.env.SSO_LOG_FALLBACK = "1";
      const importer = vi.fn(async (moduleName: string) => {
        const err = Object.assign(new Error(`Cannot find module '${moduleName}'`), {
          code: "ERR_MODULE_NOT_FOUND",
        });
        throw err;
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      try {
        const controller = new LazyController(fakePrisma, { importer });
        await controller.isUsingPlugin();
        const fallbackLogs = logSpy.mock.calls.filter((args) =>
          args.some(
            (a) => typeof a === "string" && a.includes("no plugin installed")
          )
        );
        expect(fallbackLogs.length).toBe(1);
      } finally {
        logSpy.mockRestore();
        if (previous === undefined) delete process.env.SSO_LOG_FALLBACK;
        else process.env.SSO_LOG_FALLBACK = previous;
      }
    });
  });

  describe("plugin broken (transitive dep missing or init error)", () => {
    it("logs a console.error and falls back", async () => {
      const importer = vi.fn(async () => {
        // Module-not-found from a *transitive* dep, not the plugin
        // itself — its `message` won't contain the plugin's moduleName.
        const err = Object.assign(
          new Error(`Cannot find module 'some-transitive-dep'`),
          { code: "ERR_MODULE_NOT_FOUND" }
        );
        throw err;
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const controller = new LazyController(fakePrisma, { importer });
        expect(await controller.isUsingPlugin()).toBe(false);
        expect(errorSpy).toHaveBeenCalled();
        const firstCallArgs = errorSpy.mock.calls[0]!;
        expect(
          firstCallArgs.some(
            (a) => typeof a === "string" && a.includes("plugin found but failed to load")
          )
        ).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("logs a console.error for non-module-not-found errors too", async () => {
      const importer = vi.fn(async () => {
        throw new SyntaxError("Unexpected token in plugin source");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const controller = new LazyController(fakePrisma, { importer });
        expect(await controller.isUsingPlugin()).toBe(false);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("plugin found", () => {
    it("delegates isUsingPlugin to the plugin implementation", async () => {
      const stub = makeStubController();
      const plugin: SsoPlugin = { create: () => stub };
      const importer = vi.fn(async () => ({ default: plugin }));

      const controller = new LazyController(fakePrisma, { importer });
      expect(await controller.isUsingPlugin()).toBe(true);
    });

    it("delegates decideRouteForEmail and propagates the result", async () => {
      const stub = makeStubController();
      const plugin: SsoPlugin = { create: () => stub };
      const importer = vi.fn(async () => ({ default: plugin }));

      const controller = new LazyController(fakePrisma, { importer });
      const decision = await controller.decideRouteForEmail("admin@example.com");
      expect(decision.isOk()).toBe(true);
      expect(decision._unsafeUnwrap()).toEqual({
        kind: "sso_required",
        idpOrgId: "idp_stub",
      });
    });

    it("propagates plugin errors through ResultAsync", async () => {
      const stub = makeStubController();
      const plugin: SsoPlugin = { create: () => stub };
      const importer = vi.fn(async () => ({ default: plugin }));

      const controller = new LazyController(fakePrisma, { importer });
      const profile: SsoProfile = {
        email: "user@example.com",
        firstName: null,
        lastName: null,
        idpSubjectId: "sub_x",
        idpOrgId: "idp_stub",
        idpConnectionId: "conn_x",
      };
      const result = await controller.resolveSsoIdentity({ profile });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("feature_disabled");
    });

    it("loads the plugin module only once across many calls", async () => {
      const stub = makeStubController();
      const plugin: SsoPlugin = { create: () => stub };
      const importer = vi.fn(async () => ({ default: plugin }));

      const controller = new LazyController(fakePrisma, { importer });
      await controller.isUsingPlugin();
      await controller.decideRouteForEmail("a@example.com");
      await controller.decideRouteForEmail("b@example.com");
      expect(importer).toHaveBeenCalledTimes(1);
    });
  });

  describe("forceFallback option", () => {
    it("skips the importer entirely", async () => {
      const importer = vi.fn();
      const controller = new LazyController(fakePrisma, {
        forceFallback: true,
        importer: importer as never,
      });
      expect(await controller.isUsingPlugin()).toBe(false);
      expect(importer).not.toHaveBeenCalled();
    });
  });

  describe("loader.create() factory", () => {
    it("returns a working LazyController", async () => {
      const controller = loader.create(fakePrisma, { forceFallback: true });
      expect(await controller.isUsingPlugin()).toBe(false);
      const decision = await controller.decideRouteForEmail("x@example.com");
      expect(decision._unsafeUnwrap()).toEqual({ kind: "no_sso" });
    });
  });

  describe("fallback parameter shapes", () => {
    it("propagates SsoFlow through beginAuthorization (uses fallback for error path)", async () => {
      // Smoke test that `SsoFlow` typing flows through. Plugin not present →
      // beginAuthorization returns `feature_disabled` per the fallback.
      const controller = loader.create(fakePrisma, { forceFallback: true });
      const flow: SsoFlow = "user_initiated";
      const result = await controller.beginAuthorization({
        email: "x@example.com",
        redirectTo: "/",
        flow,
      });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("feature_disabled");
    });
  });
});
