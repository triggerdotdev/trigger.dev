import type {
  ApiKeyPolicyDescription,
  ApiKeyPreset,
  BearerAuthOptions,
  BearerAuthResult,
  Permission,
  PrepareApiKeyPolicyResult,
  RbacAbility,
  RbacDatabaseConfig,
  Role,
  RbacResource,
  RoleAssignmentResult,
  RoleBaseAccessController,
  RoleBasedAccessControlPlugin,
  RoleMutationResult,
} from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import { isPublicJWT } from "@trigger.dev/core/v3/jwt";

import { RoleBaseAccessFallback } from "./fallback.js";
// Single source of truth for the capless-token scope ceiling; the env-JWT
// exchange route imports it to project requested scopes against it.
export { CAPLESS_USER_ACTOR_SCOPES } from "./fallback.js";
import { BearerCredentialResolver, type BearerResolution } from "./bearerCredentials.js";
export type {
  BearerAuthOptions,
  RoleBaseAccessController,
  RbacAbility,
  RbacResource,
} from "@trigger.dev/plugins";
export type {
  BearerCredentialKind,
  BearerLookupPath,
  BearerResolution,
} from "./bearerCredentials.js";

/**
 * The controller surface as the HOST sees it, after LazyController has filled in
 * defaults for the optional capability methods a plugin may not implement.
 *
 * `RoleBaseAccessController` is the *plugin-facing* contract, where capability
 * extensions are optional so an older plugin still satisfies it. Host code
 * always talks to the LazyController singleton (`rbac`), which never omits a
 * method — so host consumers should depend on this type, not on the plugin
 * contract, and get a total surface without writing their own guards.
 */
export type HostBearerAuthResult = BearerAuthResult & { resolution: BearerResolution };

export type HostRbacController = Omit<Required<RoleBaseAccessController>, "authenticateBearer"> & {
  authenticateBearer(request: Request, options?: BearerAuthOptions): Promise<HostBearerAuthResult>;
};
export type { UserActorAuthResult, UserActorClaims } from "@trigger.dev/plugins";
export { buildJwtAbility, scopesWithinAbility } from "./ability.js";
export { FULL_ACCESS_PRESET_ID, scopesGrantFullAccess } from "@trigger.dev/plugins";
export { resolveJwtSigningKey } from "./bearerCredentials.js";
// Re-export the user-actor token grammar so the webapp mints/checks tokens
// through @trigger.dev/rbac (it doesn't import @trigger.dev/plugins directly).
export {
  isUserActorToken,
  signUserActorToken,
  verifyUserActorToken,
  USER_ACTOR_TOKEN_PREFIX,
} from "@trigger.dev/plugins";

// Either a single PrismaClient (used for both writes and reads — fine
// for callers that don't have a separate replica), or `{primary, replica}`
// where reads on the auth hot path go to the replica. The fallback
// reads on every request, so callers with a replica should pass both.
export type RbacPrismaInput = PrismaClient | { primary: PrismaClient; replica: PrismaClient };

export type RbacCreateOptions = {
  // When true, skip loading the plugin, useful for tests
  forceFallback?: boolean;
  // Platform secret used to verify delegated user-actor tokens (tr_uat_).
  // Threaded through to the plugin / fallback's authenticateUserActor.
  userActorSecret?: string;
  // Writer/reader connection URLs + pool sizes for a plugin that owns its
  // own database client, resolved by the host from its env so the plugin
  // follows the host's writer/replica topology. The fallback ignores this —
  // it queries through the Prisma clients passed as `RbacPrismaInput`.
  database?: RbacDatabaseConfig;
  // Synchronous host-owned rollout control. Defaults to enabled for non-webapp
  // consumers; the webapp passes its cold-safe global flag reader.
  additionalApiKeyLookupEnabled?: () => boolean;
};

// Route actions that historically authorised via the legacy checkAuthorization's
// superScopes escape hatch — e.g. a JWT with scope "write:tasks" was accepted by
// a route with action: "trigger" because "write:tasks" was listed in the route's
// superScopes array. The new ability model matches scope-action strictly, so we
// restore the prior semantic here: when the underlying ability denies for action
// X, retry with each aliased action.
const ACTION_ALIASES: Record<string, readonly string[]> = {
  trigger: ["write"],
  batchTrigger: ["write"],
  update: ["write"],
};

export function withActionAliases(underlying: RbacAbility): RbacAbility {
  return {
    can(action: string, resource: RbacResource | RbacResource[]): boolean {
      if (underlying.can(action, resource)) return true;
      const aliases = ACTION_ALIASES[action] ?? [];
      return aliases.some((a) => underlying.can(a, resource));
    },
    canSuper: () => underlying.canSuper(),
  };
}

function resolveBearerResolution(
  result: BearerAuthResult,
  context: {
    useHostForAdditionalKey: boolean;
    useHostForPublicJWT: boolean;
    rawToken: string | undefined;
    usingPlugin: boolean;
  }
): BearerResolution {
  if ("resolution" in result) {
    return result.resolution as BearerResolution;
  }

  if (context.useHostForAdditionalKey) {
    return { credentialKind: "additional_api_key", lookupPath: "additional" };
  }

  if (context.useHostForPublicJWT) {
    return { credentialKind: "public_jwt", lookupPath: "jwt_current" };
  }

  return {
    credentialKind: context.rawToken?.startsWith("tr_") ? "root_api_key" : "unknown",
    lookupPath: context.usingPlugin ? "plugin" : "not_found",
  };
}

// Loads the plugin lazily; falls back to the fallback implementation if not installed.
// Synchronous create() avoids top-level await (not supported in the webapp's CJS build).
class LazyController implements RoleBaseAccessController {
  private readonly _init: Promise<RoleBaseAccessController>;
  // Additional API keys (the ApiKey table) are host-owned, not known to the
  // optional plugin. The host resolves them with its always-on credential
  // resolver — not a full RBAC fallback controller.
  private readonly _hostCredentialResolver: BearerCredentialResolver;

  constructor(prisma: RbacPrismaInput, options?: RbacCreateOptions) {
    this._hostCredentialResolver = new BearerCredentialResolver(
      "primary" in prisma ? prisma : { primary: prisma, replica: prisma },
      options?.additionalApiKeyLookupEnabled
    );
    this._init = this.load(prisma, options);
    // load() runs eagerly but the result is awaited lazily on first method
    // call. If load() rejects (e.g. REQUIRE_PLUGINS=1 + plugin missing) and
    // nothing awaits _init before Node ticks past, the rejection surfaces
    // as unhandledRejection and kills the process. Attach a no-op .catch
    // so Node sees the rejection as handled; the error is re-thrown when
    // any consumer awaits this._init via c().
    this._init.catch(() => {});
  }

  private async load(
    prisma: RbacPrismaInput,
    options?: RbacCreateOptions
  ): Promise<RoleBaseAccessController> {
    if (options?.forceFallback) {
      return new RoleBaseAccessFallback(prisma, {
        userActorSecret: options?.userActorSecret,
        additionalApiKeyLookupEnabled: options?.additionalApiKeyLookupEnabled,
      }).create();
    }
    const moduleName = "@triggerdotdev/plugins/rbac";
    try {
      // Optional plugin, resolved at runtime only
      const module = await import(/* @vite-ignore */ moduleName);
      const plugin: RoleBasedAccessControlPlugin = module.default;
      console.log("RBAC: using plugin implementation");
      return plugin.create({
        userActorSecret: options?.userActorSecret,
        database: options?.database,
      });
    } catch (err) {
      // The dynamic import either succeeded or failed for one of two
      // distinct reasons. Distinguishing them is critical for debugging
      // — silently swallowing the error here is what produced "why is
      // the fallback being used?" mysteries before.
      //
      // 1. The plugin itself is absent (no install) — expected.
      //    Logged at info level only when RBAC_LOG_FALLBACK=1 so
      //    production logs stay quiet.
      // 2. Anything else (transitive dep missing, init error, syntax
      //    error in the plugin's dist, etc.) — a real bug. Always
      //    logged loudly so it surfaces in CI / production logs.
      //
      // Node throws ERR_MODULE_NOT_FOUND for both cases — the *plugin*
      // module being absent and a *transitive* dep of the plugin
      // being absent. Disambiguate by checking whether the missing
      // specifier in the error message is the plugin's own moduleName.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const message = err instanceof Error ? err.message : String(err);
      const isModuleNotFound = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
      const isPluginItselfMissing = isModuleNotFound && message.includes(moduleName);

      if (!isPluginItselfMissing) {
        // Either the error wasn't a missing-module error at all, or the
        // plugin was found but a transitive dep failed to resolve.
        // Either way: a real problem worth surfacing.
        console.error(
          "RBAC: plugin found but failed to load; falling back to default implementation",
          err
        );
      } else if (process.env.RBAC_LOG_FALLBACK === "1") {
        console.log("RBAC: no plugin installed (ERR_MODULE_NOT_FOUND); using fallback");
      }

      // Fail-fast for deployments that require plugins to be present. Set
      // REQUIRE_PLUGINS=1 in environments where the fallback is not an
      // acceptable degraded state — the throw surfaces on the first method
      // call on the lazy controller (e.g. via the webapp's /healthcheck
      // route), so the rollout's readiness probe fails and the deploy is
      // rolled back. Self-hosters leave REQUIRE_PLUGINS unset and continue
      // to use the fallback when no plugin is installed.
      if (process.env.REQUIRE_PLUGINS === "1") {
        throw new Error(`REQUIRE_PLUGINS=1 but plugin "${moduleName}" did not load: ${message}`);
      }

      return new RoleBaseAccessFallback(prisma, {
        userActorSecret: options?.userActorSecret,
        additionalApiKeyLookupEnabled: options?.additionalApiKeyLookupEnabled,
      }).create();
    }
  }

  private async c(): Promise<RoleBaseAccessController> {
    return this._init;
  }

  async isUsingPlugin(): Promise<boolean> {
    return (await this.c()).isUsingPlugin();
  }

  async authenticateBearer(...args: Parameters<RoleBaseAccessController["authenticateBearer"]>) {
    const controller = await this.c();
    const usingPlugin = await controller.isUsingPlugin();
    const [request, options] = args;
    const rawToken = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    const useHostForPublicJWT = Boolean(options?.allowJWT && rawToken && isPublicJWT(rawToken));
    const useHostForAdditionalKey = Boolean(
      !useHostForPublicJWT && usingPlugin && rawToken && isAdditionalApiKey(rawToken)
    );

    // Public JWT validation and additional environment API keys are host-owned.
    // Route those formats directly to the host; all other bearer credentials
    // remain authoritative in the installed controller.
    const result =
      useHostForPublicJWT || useHostForAdditionalKey
        ? await this._hostCredentialResolver.authenticate(...args)
        : await controller.authenticateBearer(...args);

    const resolution = resolveBearerResolution(result, {
      useHostForAdditionalKey,
      useHostForPublicJWT,
      rawToken,
      usingPlugin,
    });

    // The format is only a routing hint. A successful host resolution on the
    // additional-key path must still produce the expected principal type.
    if (useHostForAdditionalKey && result.ok && result.subject.type !== "apiKey") {
      return {
        ok: false as const,
        status: 401 as const,
        error: "Invalid API key",
        resolution: {
          credentialKind: "additional_api_key" as const,
          lookupPath: "additional" as const,
        },
      };
    }

    return result.ok
      ? { ...result, ability: withActionAliases(result.ability), resolution }
      : { ...result, resolution };
  }

  async authenticateSession(...args: Parameters<RoleBaseAccessController["authenticateSession"]>) {
    const result = await (await this.c()).authenticateSession(...args);
    return result.ok ? { ...result, ability: withActionAliases(result.ability) } : result;
  }

  // Don't delegate to the underlying Authorize variants — that would run the
  // inline ability check against the unwrapped ability. Use our wrapped
  // authenticate* and do the ability check here instead.
  async authenticateAuthorizeBearer(
    request: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>[0],
    check: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>[1],
    options?: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>[2]
  ) {
    const auth = await this.authenticateBearer(request, options);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false as const, status: 403 as const, error: "Unauthorized" };
    }
    return auth;
  }

  async authenticateAuthorizeSession(
    request: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>[0],
    context: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>[1],
    check: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>[2]
  ) {
    const auth = await this.authenticateSession(request, context);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false as const, reason: "unauthorized" as const };
    }
    return auth;
  }

  async authenticatePat(...args: Parameters<RoleBaseAccessController["authenticatePat"]>) {
    const result = await (await this.c()).authenticatePat(...args);
    return result.ok ? { ...result, ability: withActionAliases(result.ability) } : result;
  }

  async authenticateUserActor(
    ...args: Parameters<RoleBaseAccessController["authenticateUserActor"]>
  ) {
    const result = await (await this.c()).authenticateUserActor(...args);
    return result.ok ? { ...result, ability: withActionAliases(result.ability) } : result;
  }

  async systemRoles(...args: Parameters<RoleBaseAccessController["systemRoles"]>) {
    return (await this.c()).systemRoles(...args);
  }

  // The API-key policy methods are optional on the controller contract (see the
  // note on RoleBaseAccessController) so a plugin compiled against an older OSS
  // commit still satisfies it. LazyController is where that optional surface is
  // normalized into a total one: every host caller goes through `rbac`, so the
  // absent-plugin default lives here once instead of at each call site.
  async apiKeyPresets(
    ...args: Parameters<NonNullable<RoleBaseAccessController["apiKeyPresets"]>>
  ): Promise<ApiKeyPreset[] | null> {
    const controller = await this.c();
    // Same meaning as the no-plugin fallback: no catalogue to offer.
    return controller.apiKeyPresets ? controller.apiKeyPresets(...args) : null;
  }

  async prepareApiKeyPolicy(
    ...args: Parameters<NonNullable<RoleBaseAccessController["prepareApiKeyPolicy"]>>
  ): Promise<PrepareApiKeyPolicyResult> {
    const controller = await this.c();
    if (!controller.prepareApiKeyPolicy) {
      // Fail closed. A plugin that predates this contract must not be able to
      // mint a credential — least of all a full-access one — so creation stops
      // outright. Keys already issued are unaffected: they authorize from the
      // scopes persisted on their row, compiled by the host bearer resolver.
      return { ok: false, error: "API key access presets are not available" };
    }
    return controller.prepareApiKeyPolicy(...args);
  }

  async describeApiKeyPolicy(
    ...args: Parameters<NonNullable<RoleBaseAccessController["describeApiKeyPolicy"]>>
  ): Promise<ApiKeyPolicyDescription> {
    const controller = await this.c();
    // Presentation only — an undescribed policy renders from its stored scopes.
    return controller.describeApiKeyPolicy ? controller.describeApiKeyPolicy(...args) : {};
  }

  async allPermissions(
    ...args: Parameters<RoleBaseAccessController["allPermissions"]>
  ): Promise<Permission[]> {
    return (await this.c()).allPermissions(...args);
  }

  async allRoles(...args: Parameters<RoleBaseAccessController["allRoles"]>): Promise<Role[]> {
    return (await this.c()).allRoles(...args);
  }

  async getAssignableRoleIds(
    ...args: Parameters<RoleBaseAccessController["getAssignableRoleIds"]>
  ): Promise<string[]> {
    return (await this.c()).getAssignableRoleIds(...args);
  }

  async createRole(
    ...args: Parameters<RoleBaseAccessController["createRole"]>
  ): Promise<RoleMutationResult> {
    return (await this.c()).createRole(...args);
  }

  async updateRole(
    ...args: Parameters<RoleBaseAccessController["updateRole"]>
  ): Promise<RoleMutationResult> {
    return (await this.c()).updateRole(...args);
  }

  async deleteRole(
    ...args: Parameters<RoleBaseAccessController["deleteRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).deleteRole(...args);
  }

  async getUserRole(
    ...args: Parameters<RoleBaseAccessController["getUserRole"]>
  ): Promise<Role | null> {
    return (await this.c()).getUserRole(...args);
  }

  async getUserRoles(
    ...args: Parameters<RoleBaseAccessController["getUserRoles"]>
  ): Promise<Map<string, Role | null>> {
    return (await this.c()).getUserRoles(...args);
  }

  async setUserRole(
    ...args: Parameters<RoleBaseAccessController["setUserRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).setUserRole(...args);
  }

  async removeUserRole(
    ...args: Parameters<RoleBaseAccessController["removeUserRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).removeUserRole(...args);
  }

  async getTokenRole(
    ...args: Parameters<RoleBaseAccessController["getTokenRole"]>
  ): Promise<Role | null> {
    return (await this.c()).getTokenRole(...args);
  }

  async setTokenRole(
    ...args: Parameters<RoleBaseAccessController["setTokenRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).setTokenRole(...args);
  }

  async removeTokenRole(
    ...args: Parameters<RoleBaseAccessController["removeTokenRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).removeTokenRole(...args);
  }
}

class RoleBaseAccess {
  // Synchronous — returns a lazy controller that resolves any installed
  // plugin on first call.
  //
  // Returns HostRbacController, not RoleBaseAccessController: the latter is the
  // plugin-facing contract whose capability methods are optional, and
  // LazyController has already substituted defaults for any the installed plugin
  // omits. Handing back the total surface is what keeps host callers from having
  // to guard (or, worse, from inventing their own absent-plugin default).
  create(prisma: RbacPrismaInput, options?: RbacCreateOptions): HostRbacController {
    return new LazyController(prisma, options);
  }
}

const loader = new RoleBaseAccess();

export default loader;
