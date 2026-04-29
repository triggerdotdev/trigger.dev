import { MachinePresetName, tryCatch } from "@trigger.dev/core/v3";
import type { Organization, Project, RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  BillingClient,
  defaultMachine as defaultMachineFromPlatform,
  machines as machinesFromPlatform,
  type BillingAlertsResult,
  type CreatePrivateLinkConnectionBody,
  type Limits,
  type MachineCode,
  type PrivateLinkConnection,
  type PrivateLinkConnectionList,
  type PrivateLinkRegionsResult,
  type ReportUsageResult,
  type SetPlanBody,
  type UpdateBillingAlertsRequest,
  type UsageResult,
  type UsageSeriesParams,
  type CurrentPlan,
  type ApplyCouponDealResponse,
  type CouponDiagnosticsResponse,
  type ListCouponDealsResponse,
  type ResolveCouponCustomerResponse,
} from "@trigger.dev/platform";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { existsSync, readFileSync } from "node:fs";
import { redirect } from "remix-typedjson";
import { z } from "zod";
import { env } from "~/env.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createEnvironment } from "~/models/organization.server";
import { logger } from "~/services/logger.server";
import { newProjectPath, organizationBillingPath } from "~/utils/pathBuilder";
import { singleton } from "~/utils/singleton";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";
import { $replica } from "~/db.server";
import { metrics } from "@opentelemetry/api";

function initializeClient() {
  if (isCloud() && process.env.BILLING_API_URL && process.env.BILLING_API_KEY) {
    const client = new BillingClient({
      url: process.env.BILLING_API_URL,
      apiKey: process.env.BILLING_API_KEY,
    });
    return client;
  }
}

const client = singleton("billingClient", initializeClient);
// Failures from @trigger.dev/platform billing client calls are tracked via
// this metric (with low-cardinality {function, kind} labels) rather than
// logged. Every task invocation hits these paths, so per-call logs were too
// noisy; dashboard the counter for visibility instead.
const platformClientMeter = metrics.getMeter("trigger.dev/platform-client");
const platformClientFailuresCounter = platformClientMeter.createCounter(
  "platform_client.failures_total",
  {
    description:
      "Failures returned or thrown by @trigger.dev/platform billing client calls",
  }
);

function recordPlatformFailure(fn: string, kind: "caught" | "no_success") {
  platformClientFailuresCounter.add(1, { function: fn, kind });
}


function initializePlatformCache() {
  const ctx = new DefaultStatefulContext();
  const memory = createLRUMemoryStore(1000);
  const redisCacheStore = new RedisCacheStore({
    connection: {
      keyPrefix: "tr:cache:platform:v3",
      port: env.CACHE_REDIS_PORT,
      host: env.CACHE_REDIS_HOST,
      username: env.CACHE_REDIS_USERNAME,
      password: env.CACHE_REDIS_PASSWORD,
      tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
      clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  // This cache holds the limits fetched from the platform service
  const cache = createCache({
    limits: new Namespace<number>(ctx, {
      stores: [memory, redisCacheStore],
      fresh: 60_000 * 5, // 5 minutes
      stale: 60_000 * 10, // 10 minutes
    }),
    usage: new Namespace<UsageResult>(ctx, {
      stores: [memory, redisCacheStore],
      fresh: 60_000 * 5, // 5 minutes
      stale: 60_000 * 10, // 10 minutes
    }),
    entitlement: new Namespace<ReportUsageResult>(ctx, {
      stores: [memory, redisCacheStore],
      fresh: 60_000, // serve without revalidation for 60s
      stale: 120_000, // total TTL — fresh 0-60s, stale-revalidate 60-120s
    }),
  });

  return cache;
}

const platformCache = singleton("platformCache", initializePlatformCache);

type Machines = typeof machinesFromPlatform;

const MachineOverrideValues = z.object({
  cpu: z.number(),
  memory: z.number(),
});
type MachineOverrideValues = z.infer<typeof MachineOverrideValues>;

const MachineOverrides = z.record(MachinePresetName, MachineOverrideValues.partial());
type MachineOverrides = z.infer<typeof MachineOverrides>;

const MachinePresetOverrides = z.object({
  defaultMachine: MachinePresetName.optional(),
  machines: MachineOverrides.optional(),
});

function initializeMachinePresets(): {
  defaultMachine: MachineCode;
  machines: Machines;
} {
  const overrides = getMachinePresetOverrides();

  if (!overrides) {
    return {
      defaultMachine: defaultMachineFromPlatform,
      machines: machinesFromPlatform,
    };
  }

  logger.info("🎛️ Overriding machine presets", { overrides });

  return {
    defaultMachine: overrideDefaultMachine(defaultMachineFromPlatform, overrides.defaultMachine),
    machines: overrideMachines(machinesFromPlatform, overrides.machines),
  };
}

export const { defaultMachine, machines } = singleton("machinePresets", initializeMachinePresets);

function overrideDefaultMachine(defaultMachine: MachineCode, override?: MachineCode): MachineCode {
  if (!override) {
    return defaultMachine;
  }

  return override;
}

function overrideMachines(machines: Machines, overrides?: MachineOverrides): Machines {
  if (!overrides) {
    return machines;
  }

  const mergedMachines = {
    ...machines,
  };

  for (const machine of Object.keys(overrides) as MachinePresetName[]) {
    mergedMachines[machine] = {
      ...mergedMachines[machine],
      ...overrides[machine],
    };
  }

  return mergedMachines;
}

function getMachinePresetOverrides() {
  const path = env.MACHINE_PRESETS_OVERRIDE_PATH;
  if (!path) {
    return;
  }

  const overrides = safeReadMachinePresetOverrides(path);
  if (!overrides) {
    return;
  }

  const parsed = MachinePresetOverrides.safeParse(overrides);

  if (!parsed.success) {
    logger.error("Error parsing machine preset overrides", { path, error: parsed.error });
    return;
  }

  return parsed.data;
}

function safeReadMachinePresetOverrides(path: string) {
  try {
    const fileExists = existsSync(path);
    if (!fileExists) {
      logger.error("Machine preset overrides file does not exist", { path });
      return;
    }

    const fileContents = readFileSync(path, "utf8");

    return JSON.parse(fileContents);
  } catch (error) {
    logger.error("Error reading machine preset overrides", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

export async function getCurrentPlan(orgId: string) {
  if (!client) return undefined;

  try {
    const result = await client.currentPlan(orgId);

    const firstDayOfMonth = new Date();
    firstDayOfMonth.setUTCDate(1);
    firstDayOfMonth.setUTCHours(0, 0, 0, 0);

    const firstDayOfNextMonth = new Date();
    firstDayOfNextMonth.setUTCDate(1);
    firstDayOfNextMonth.setUTCMonth(firstDayOfNextMonth.getUTCMonth() + 1);
    firstDayOfNextMonth.setUTCHours(0, 0, 0, 0);

    if (!result.success) {
      recordPlatformFailure("getCurrentPlan", "no_success");
      return undefined;
    }

    const periodStart = firstDayOfMonth;
    const periodEnd = firstDayOfNextMonth;
    const periodRemainingDuration = periodEnd.getTime() - new Date().getTime();

    const usage = {
      periodStart,
      periodEnd,
      periodRemainingDuration,
    };

    return { ...result, usage };
  } catch (e) {
    recordPlatformFailure("getCurrentPlan", "caught");
    return undefined;
  }
}

export async function getLimits(orgId: string) {
  if (!client) return undefined;

  try {
    const result = await client.currentPlan(orgId);
    if (!result.success) {
      recordPlatformFailure("getLimits", "no_success");
      return undefined;
    }

    return result.v3Subscription?.plan?.limits;
  } catch (e) {
    recordPlatformFailure("getLimits", "caught");
    return undefined;
  }
}

export async function getLimit(orgId: string, limit: keyof Limits, fallback: number) {
  const limits = await getLimits(orgId);
  if (!limits) return fallback;
  const result = limits[limit];

  if (!result) return fallback;
  if (typeof result === "number") return result;
  if (typeof result === "object" && "number" in result) return result.number;
  return fallback;
}

export async function getDefaultEnvironmentConcurrencyLimit(
  organizationId: string,
  environmentType: RuntimeEnvironmentType
): Promise<number> {
  if (!client) {
    const org = await $replica.organization.findFirst({
      where: {
        id: organizationId,
      },
      select: {
        maximumConcurrencyLimit: true,
      },
    });
    if (!org) throw new Error("Organization not found");
    return org.maximumConcurrencyLimit;
  }

  const result = await client.currentPlan(organizationId);
  if (!result.success) throw new Error("Error getting current plan");

  const limit = getDefaultEnvironmentLimitFromPlan(environmentType, result);
  if (!limit) throw new Error("No plan found");

  return limit;
}

export function getDefaultEnvironmentLimitFromPlan(
  environmentType: RuntimeEnvironmentType,
  plan: CurrentPlan
): number | undefined {
  if (!plan.v3Subscription?.plan) return undefined;

  switch (environmentType) {
    case "DEVELOPMENT":
      return plan.v3Subscription.plan.limits.concurrentRuns.development;
    case "STAGING":
      return plan.v3Subscription.plan.limits.concurrentRuns.staging;
    case "PREVIEW":
      return plan.v3Subscription.plan.limits.concurrentRuns.preview;
    case "PRODUCTION":
      return plan.v3Subscription.plan.limits.concurrentRuns.production;
    default:
      return plan.v3Subscription.plan.limits.concurrentRuns.number;
  }
}

export async function getCachedLimit(orgId: string, limit: keyof Limits, fallback: number) {
  return platformCache.limits.swr(`${orgId}:${limit}`, async () => {
    return getLimit(orgId, limit, fallback);
  });
}

export async function customerPortalUrl(orgId: string, orgSlug: string) {
  if (!client) return undefined;

  try {
    return client.createPortalSession(orgId, {
      returnUrl: `${env.APP_ORIGIN}${organizationBillingPath({ slug: orgSlug })}`,
    });
  } catch (e) {
    recordPlatformFailure("customerPortalUrl", "caught");
    return undefined;
  }
}

export async function getPlans() {
  if (!client) return undefined;

  try {
    const result = await client.plans();
    if (!result.success) {
      recordPlatformFailure("getPlans", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("getPlans", "caught");
    return undefined;
  }
}

export async function setPlan(
  organization: { id: string; slug: string },
  request: Request,
  callerPath: string,
  plan: SetPlanBody,
  opts?: { invalidateBillingCache?: (orgId: string) => void }
) {
  if (!client) {
    return redirectWithErrorMessage(callerPath, request, "Error setting plan", {
      ephemeral: false,
    });
  }

  const [error, result] = await tryCatch(client.setPlan(organization.id, plan));

  if (error) {
    return redirectWithErrorMessage(callerPath, request, error.message, { ephemeral: false });
  }

  if (!result) {
    return redirectWithErrorMessage(callerPath, request, "Error setting plan", {
      ephemeral: false,
    });
  }

  if (!result.success) {
    return redirectWithErrorMessage(callerPath, request, result.error, { ephemeral: false });
  }

  switch (result.action) {
    case "free_connect_required": {
      return redirect(result.connectUrl);
    }
    case "free_connected": {
      if (result.accepted) {
        // Invalidate billing cache since plan changed
        opts?.invalidateBillingCache?.(organization.id);
        platformCache.entitlement.remove(organization.id).catch(() => {});
        return redirect(newProjectPath(organization, "You're on the Free plan."));
      } else {
        return redirectWithErrorMessage(
          callerPath,
          request,
          "Free tier unlock failed, your GitHub account is too new.",
          { ephemeral: false }
        );
      }
    }
    case "create_subscription_flow_start": {
      return redirect(result.checkoutUrl);
    }
    case "updated_subscription": {
      // Invalidate billing cache since subscription changed
      opts?.invalidateBillingCache?.(organization.id);
      platformCache.entitlement.remove(organization.id).catch(() => {});
      return redirectWithSuccessMessage(callerPath, request, "Subscription updated successfully.");
    }
    case "canceled_subscription": {
      // Invalidate billing cache since subscription was canceled
      opts?.invalidateBillingCache?.(organization.id);
      platformCache.entitlement.remove(organization.id).catch(() => {});
      return redirectWithSuccessMessage(callerPath, request, "Subscription canceled.");
    }
  }
}

export async function setConcurrencyAddOn(organizationId: string, amount: number) {
  if (!client) return undefined;

  try {
    const result = await client.setAddOn(organizationId, { type: "concurrency", amount });
    if (!result.success) {
      recordPlatformFailure("setConcurrencyAddOn", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("setConcurrencyAddOn", "caught");
    return undefined;
  }
}

export async function setSeatsAddOn(organizationId: string, amount: number) {
  if (!client) return undefined;

  try {
    const result = await client.setAddOn(organizationId, { type: "seats", amount });
    if (!result.success) {
      recordPlatformFailure("setSeatsAddOn", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("setSeatsAddOn", "caught");
    return undefined;
  }
}

export async function setBranchesAddOn(organizationId: string, amount: number) {
  if (!client) return undefined;

  try {
    const result = await client.setAddOn(organizationId, { type: "branches", amount });
    if (!result.success) {
      recordPlatformFailure("setBranchesAddOn", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("setBranchesAddOn", "caught");
    return undefined;
  }
}

export async function getUsage(organizationId: string, { from, to }: { from: Date; to: Date }) {
  if (!client) return undefined;

  try {
    const result = await client.usage(organizationId, { from, to });
    if (!result.success) {
      recordPlatformFailure("getUsage", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("getUsage", "caught");
    return undefined;
  }
}

export async function getCachedUsage(
  organizationId: string,
  { from, to }: { from: Date; to: Date }
) {
  if (!client) return undefined;

  const result = await platformCache.usage.swr(
    `${organizationId}:${from.toISOString()}:${to.toISOString()}`,
    async () => {
      const usageResponse = await getUsage(organizationId, { from, to });

      return usageResponse;
    }
  );

  return result.val;
}

export async function getUsageSeries(organizationId: string, params: UsageSeriesParams) {
  if (!client) return undefined;

  try {
    const result = await client.usageSeries(organizationId, params);
    if (!result.success) {
      recordPlatformFailure("getUsageSeries", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("getUsageSeries", "caught");
    return undefined;
  }
}

export async function reportInvocationUsage(
  organizationId: string,
  costInCents: number,
  additionalData?: Record<string, any>
) {
  if (!client) return undefined;

  try {
    const result = await client.reportInvocationUsage({
      organizationId,
      costInCents,
      additionalData,
    });
    if (!result.success) {
      recordPlatformFailure("reportInvocationUsage", "no_success");
      return undefined;
    }
    return result;
  } catch (e) {
    recordPlatformFailure("reportInvocationUsage", "caught");
    return undefined;
  }
}

export async function reportComputeUsage(request: Request) {
  if (!client) return undefined;

  return fetch(`${process.env.BILLING_API_URL}/api/v1/usage/ingest/compute`, {
    method: "POST",
    headers: request.headers,
    body: await request.text(),
  });
}

export async function getEntitlement(
  organizationId: string
): Promise<ReportUsageResult | undefined> {
  if (!client) return undefined;

  // Errors must be caught inside the loader — @unkey/cache passes the loader
  // promise to waitUntil() with no .catch(), so an unhandled rejection during
  // background SWR revalidation would crash the process. Returning undefined
  // on error tells SWR not to commit a fail-open value to the cache, which
  // prevents transient billing errors from overwriting a legitimate
  // hasAccess: false entry. The fail-open default is applied *outside* the
  // SWR call so it never becomes a cached access decision.
  const result = await platformCache.entitlement.swr(organizationId, async () => {
    try {
      const response = await client.getEntitlement(organizationId);
      if (!response.success) {
        recordPlatformFailure("getEntitlement", "no_success");
        return undefined;
      }
      return response;
    } catch (e) {
      recordPlatformFailure("getEntitlement", "caught");
      return undefined;
    }
  });

  if (result.err || result.val === undefined) {
    return {
      hasAccess: true as const,
    };
  }

  return result.val;
}

export async function projectCreated(
  organization: Pick<Organization, "id" | "maximumConcurrencyLimit">,
  project: Project
) {
  if (!isCloud()) {
    await createEnvironment({ organization, project, type: "STAGING" });
    await createEnvironment({
      organization,
      project,
      type: "PREVIEW",
      isBranchableEnvironment: true,
    });
  } else {
    //staging is only available on certain plans
    const plan = await getCurrentPlan(organization.id);
    if (plan?.v3Subscription.plan?.limits.hasStagingEnvironment) {
      await createEnvironment({ organization, project, type: "STAGING" });
      await createEnvironment({
        organization,
        project,
        type: "PREVIEW",
        isBranchableEnvironment: true,
      });
    }
  }
}

export async function getBillingAlerts(
  organizationId: string
): Promise<BillingAlertsResult | undefined> {
  if (!client) return undefined;
  const result = await client.getBillingAlerts(organizationId);
  if (!result.success) {
    recordPlatformFailure("getBillingAlert", "no_success");
    throw new Error("Error getting billing alert");
  }
  return result;
}

export async function setBillingAlert(
  organizationId: string,
  alert: UpdateBillingAlertsRequest
): Promise<BillingAlertsResult | undefined> {
  if (!client) return undefined;
  const result = await client.updateBillingAlerts(organizationId, alert);
  if (!result.success) {
    recordPlatformFailure("setBillingAlert", "no_success");
    throw new Error("Error setting billing alert");
  }
  return result;
}

export async function generateRegistryCredentials(
  projectId: string,
  region: "us-east-1" | "eu-central-1"
) {
  if (!client) return undefined;
  const result = await client.generateRegistryCredentials(projectId, region);
  if (!result.success) {
    recordPlatformFailure("generateRegistryCredentials", "no_success");
    throw new Error("Failed to generate registry credentials");
  }

  return result;
}

export async function enqueueBuild(
  projectId: string,
  deploymentId: string,
  artifactKey: string,
  options: {
    skipPromotion?: boolean;
    configFilePath?: string;
  }
) {
  if (!client) return undefined;
  const result = await client.enqueueBuild(projectId, { deploymentId, artifactKey, options });
  if (!result.success) {
    recordPlatformFailure("enqueueBuild", "no_success");
    throw new Error("Failed to enqueue build");
  }

  return result;
}

export async function getPrivateLinks(
  organizationId: string
): Promise<PrivateLinkConnectionList | undefined> {
  if (!client) return undefined;

  const [error, result] = await tryCatch(client.getPrivateLinks(organizationId));

  if (error) {
    recordPlatformFailure("getPrivateLinks", "caught");
    return undefined;
  }

  if (!result.success) {
    recordPlatformFailure("getPrivateLinks", "no_success");
    return undefined;
  }

  return result;
}

export async function createPrivateLink(
  organizationId: string,
  body: CreatePrivateLinkConnectionBody
): Promise<PrivateLinkConnection | undefined> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.createPrivateLink(organizationId, body));

  if (error) {
    recordPlatformFailure("createPrivateLink", "caught");
    throw error;
  }

  if (!result.success) {
    recordPlatformFailure("createPrivateLink", "no_success");
    throw new Error(result.error ?? "Failed to create private link");
  }

  return result;
}

export async function deletePrivateLink(
  organizationId: string,
  connectionId: string
): Promise<void> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.deletePrivateLink(organizationId, connectionId));

  if (error) {
    recordPlatformFailure("deletePrivateLink", "caught");
    throw error;
  }

  if (!result.success) {
    recordPlatformFailure("deletePrivateLink", "no_success");
    throw new Error(result.error ?? "Failed to delete private link");
  }
}

export async function getPrivateLinkRegions(
  organizationId: string
): Promise<PrivateLinkRegionsResult | undefined> {
  if (!client) return undefined;

  const [error, result] = await tryCatch(client.getPrivateLinkRegions(organizationId));

  if (error) {
    recordPlatformFailure("getPrivateLinkRegions", "caught");
    return undefined;
  }

  if (!result.success) {
    recordPlatformFailure("getPrivateLinkRegions", "no_success");
    return undefined;
  }

  return result;
}

export async function triggerInitialDeployment(
  projectId: string,
  options: { environment: "preview" | "prod" | "staging" }
): Promise<void> {
  if (!client) return;

  const [error, result] = await tryCatch(client.triggerInitialDeployment(projectId, options));

  if (error) {
    logger.warn("Error triggering initial deployment", {
      projectId,
      environment: options.environment,
      error,
    });
    return;
  }

  if (!result.success) {
    logger.warn("Failed to trigger initial deployment", {
      projectId,
      environment: options.environment,
      error: result.error,
    });
  }
}

export async function listCouponDeals(): Promise<ListCouponDealsResponse> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.listCouponDeals());

  if (error) {
    logger.error("Error listing coupon deals", { error });
    throw error;
  }

  if (!result.success) {
    logger.error("Error listing coupon deals - no success", { error: result.error });
    throw new Error(result.error ?? "Failed to list coupon deals");
  }

  return result;
}

export async function refreshCouponDeals(): Promise<ListCouponDealsResponse> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.refreshCouponDeals());

  if (error) {
    logger.error("Error refreshing coupon deals", { error });
    throw error;
  }

  if (!result.success) {
    logger.error("Error refreshing coupon deals - no success", { error: result.error });
    throw new Error(result.error ?? "Failed to refresh coupon deals");
  }

  return result;
}

export async function resolveCouponCustomer(
  stripeEmail: string
): Promise<ResolveCouponCustomerResponse> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.resolveCouponCustomer(stripeEmail));

  if (error) {
    logger.error("Error resolving coupon customer", { error });
    throw error;
  }

  if (!result.success) {
    logger.error("Error resolving coupon customer - no success", { error: result.error });
    throw new Error(result.error ?? "Failed to resolve coupon customer");
  }

  return result;
}

// Returns the full discriminated result rather than throwing on !success so the
// admin route can branch on `code` ("already_applied", "no_subscription",
// "unknown_deal", etc.) and surface precise UI messages.
export async function applyCouponDeal(input: {
  orgId: string;
  dealKey: string;
}): Promise<ApplyCouponDealResponse> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.applyCouponDeal(input));

  if (error) {
    logger.error("Error applying coupon deal", { input, error });
    throw error;
  }

  if (!result.success) {
    logger.warn("Coupon deal apply unsuccessful", { input, error: result.error });
  }

  return result;
}

export async function getCouponDiagnostics(): Promise<CouponDiagnosticsResponse> {
  if (!client) throw new Error("Platform client not configured");

  const [error, result] = await tryCatch(client.getCouponDiagnostics());

  if (error) {
    logger.error("Error getting coupon diagnostics", { error });
    throw error;
  }

  if (!result.success) {
    logger.error("Error getting coupon diagnostics - no success", { error: result.error });
    throw new Error(result.error ?? "Failed to get coupon diagnostics");
  }

  return result;
}

function isCloud(): boolean {
  const acceptableHosts = [
    "https://cloud.trigger.dev",
    "https://test-cloud.trigger.dev",
    "https://internal.trigger.dev",
  ];

  if (acceptableHosts.includes(env.LOGIN_ORIGIN)) {
    return true;
  }

  if (process.env.CLOUD_ENV === "development" && process.env.NODE_ENV === "development") {
    return true;
  }

  return false;
}
