import type {
  OrgSsoStatus,
  SsoBeginError,
  SsoCompleteError,
  SsoController,
  SsoDecisionError,
  SsoFlow,
  SsoMutationError,
  SsoPlugin,
  SsoPortalError,
  SsoProfile,
  SsoResolutionDecision,
  SsoRouteDecision,
  SsoValidateError,
  SsoWebhookError,
  SsoWebhookEvent,
} from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { ResultAsync } from "neverthrow";
import { SsoFallback } from "./fallback.js";
export type { SsoController } from "@trigger.dev/plugins";

export type SsoPrismaInput = PrismaClient | { primary: PrismaClient; replica: PrismaClient };

export type SsoCreateOptions = {
  // When true, skip loading the plugin. Useful for tests and for
  // contributors who don't have the cloud plugin installed.
  forceFallback?: boolean;
  // Override the dynamic importer. Lets tests inject a fake plugin
  // module or a synthetic ERR_MODULE_NOT_FOUND failure without touching
  // the real plugin install on disk.
  importer?: (moduleName: string) => Promise<{ default: SsoPlugin }>;
};

// Loads the cloud plugin lazily; falls back to the OSS no-op
// implementation if not installed. Synchronous create() avoids
// top-level await (not supported in the webapp's CJS build).
export class LazyController implements SsoController {
  private readonly _init: Promise<SsoController>;

  constructor(prisma: SsoPrismaInput, options?: SsoCreateOptions) {
    this._init = this.load(prisma, options);
  }

  private async load(prisma: SsoPrismaInput, options?: SsoCreateOptions): Promise<SsoController> {
    if (options?.forceFallback) {
      return new SsoFallback(prisma).create();
    }
    const moduleName = "@triggerdotdev/plugins/sso";
    const importer =
      options?.importer ?? ((m: string) => import(m) as Promise<{ default: SsoPlugin }>);
    try {
      const module = await importer(moduleName);
      const plugin: SsoPlugin = module.default;
      console.log("SSO: using plugin implementation");
      return plugin.create();
    } catch (err) {
      // Distinguish the two failure modes the dynamic import can hit:
      //
      // 1. The plugin itself is absent (no install) — expected on OSS
      //    deployments. Quiet by default; logged when SSO_LOG_FALLBACK=1
      //    so contributors can opt into a visible signal locally.
      // 2. The plugin module loaded but its initialization failed
      //    (transitive dep missing, syntax error, …). Always logged
      //    loudly because this indicates a real bug.
      //
      // Node throws ERR_MODULE_NOT_FOUND for both cases, so we
      // disambiguate by checking whether the missing specifier is the
      // plugin's own module name.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const message = err instanceof Error ? err.message : String(err);
      const isModuleNotFound = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
      const isPluginItselfMissing = isModuleNotFound && message.includes(moduleName);

      if (!isPluginItselfMissing) {
        console.error(
          "SSO: plugin found but failed to load; falling back to default implementation",
          err
        );
      } else if (process.env.SSO_LOG_FALLBACK === "1" || process.env.SSO_LOG_FALLBACK === "true") {
        console.log("SSO: no plugin installed (ERR_MODULE_NOT_FOUND); using fallback");
      }
      return new SsoFallback(prisma).create();
    }
  }

  private c(): Promise<SsoController> {
    return this._init;
  }

  // Bridges a Promise<ResultAsync<T,E>> back into a ResultAsync<T,E>.
  // The `load()` method above always resolves (it catches and falls
  // back), so `this.c()` is safe to lift via fromSafePromise. Inner
  // controller methods are expected to never throw — they return
  // errors via the Result instead — so the .andThen flatten is total.
  private call<T, E>(factory: (c: SsoController) => ResultAsync<T, E>): ResultAsync<T, E> {
    return ResultAsync.fromSafePromise(this.c().then(factory)).andThen((r) => r);
  }

  async isUsingPlugin(): Promise<boolean> {
    return (await this.c()).isUsingPlugin();
  }

  getStatus(organizationId: string): ResultAsync<OrgSsoStatus, SsoDecisionError> {
    return this.call((c) => c.getStatus(organizationId));
  }

  generatePortalLink(params: {
    organizationId: string;
    userId: string;
    intent: "sso" | "domain_verification";
    returnUrl: string;
  }): ResultAsync<{ url: string }, SsoPortalError> {
    return this.call((c) => c.generatePortalLink(params));
  }

  setEnforced(params: {
    organizationId: string;
    enforced: boolean;
  }): ResultAsync<void, SsoMutationError> {
    return this.call((c) => c.setEnforced(params));
  }

  setJitProvisioningEnabled(params: {
    organizationId: string;
    enabled: boolean;
  }): ResultAsync<void, SsoMutationError> {
    return this.call((c) => c.setJitProvisioningEnabled(params));
  }

  setJitDefaultRole(params: {
    organizationId: string;
    roleId: string | null;
  }): ResultAsync<void, SsoMutationError> {
    return this.call((c) => c.setJitDefaultRole(params));
  }

  updateConfig(params: {
    organizationId: string;
    enforced: boolean;
    jitProvisioningEnabled: boolean;
    jitDefaultRoleId: string | null;
  }): ResultAsync<void, SsoMutationError> {
    return this.call((c) => c.updateConfig(params));
  }

  decideRouteForEmail(email: string): ResultAsync<SsoRouteDecision, SsoDecisionError> {
    return this.call((c) => c.decideRouteForEmail(email));
  }

  beginAuthorization(params: {
    email: string;
    redirectTo: string;
    flow: SsoFlow;
  }): ResultAsync<{ url: string }, SsoBeginError> {
    return this.call((c) => c.beginAuthorization(params));
  }

  completeAuthorization(params: {
    code: string;
    state: string;
  }): ResultAsync<{ profile: SsoProfile; redirectTo: string; flow: SsoFlow }, SsoCompleteError> {
    return this.call((c) => c.completeAuthorization(params));
  }

  completeIdpInitiatedAuthorization(params: {
    code: string;
  }): ResultAsync<{ profile: SsoProfile; redirectTo: string }, SsoCompleteError> {
    return this.call((c) => c.completeIdpInitiatedAuthorization(params));
  }

  validateSession(params: {
    userId: string;
    idpOrgId: string;
    connectionId: string;
  }): ResultAsync<{ valid: boolean }, SsoValidateError> {
    return this.call((c) => c.validateSession(params));
  }

  resolveSsoIdentity(params: {
    profile: SsoProfile;
  }): ResultAsync<SsoResolutionDecision, SsoMutationError> {
    return this.call((c) => c.resolveSsoIdentity(params));
  }

  attachSsoIdentity(params: {
    userId: string;
    profile: SsoProfile;
  }): ResultAsync<void, SsoMutationError> {
    return this.call((c) => c.attachSsoIdentity(params));
  }

  evaluateJit(params: {
    userId: string;
    idpOrgId: string;
  }): ResultAsync<
    { shouldProvision: boolean; organizationId: string; roleId: string | null },
    SsoMutationError
  > {
    return this.call((c) => c.evaluateJit(params));
  }

  verifyWebhook(params: {
    rawBody: string;
    headers: Record<string, string>;
  }): ResultAsync<{ event: SsoWebhookEvent }, SsoWebhookError> {
    return this.call((c) => c.verifyWebhook(params));
  }

  processWebhookEvent(event: SsoWebhookEvent): ResultAsync<void, SsoWebhookError> {
    return this.call((c) => c.processWebhookEvent(event));
  }
}

class Sso {
  // Synchronous — returns a lazy controller that resolves any installed
  // plugin on first call.
  create(prisma: SsoPrismaInput, options?: SsoCreateOptions): SsoController {
    return new LazyController(prisma, options);
  }
}

const loader = new Sso();

export default loader;
