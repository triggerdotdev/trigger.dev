import { Organization, Project } from "@trigger.dev/database";
import {
  BillingClient,
  Limits,
  SetPlanBody,
  UsageSeriesParams,
  UsageResult,
} from "@trigger.dev/platform/v3";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import { redirect } from "remix-typedjson";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createEnvironment } from "~/models/organization.server";
import { logger } from "~/services/logger.server";
import { newProjectPath, organizationBillingPath } from "~/utils/pathBuilder";
import { singleton } from "~/utils/singleton";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";

function initializeClient() {
  if (isCloud() && process.env.BILLING_API_URL && process.env.BILLING_API_KEY) {
    const client = new BillingClient({
      url: process.env.BILLING_API_URL,
      apiKey: process.env.BILLING_API_KEY,
    });
    console.log(`🤑 Billing client initialized: ${process.env.BILLING_API_URL}`);
    return client;
  } else {
    console.log(`🤑 Billing client not initialized`);
  }
}

const client = singleton("billingClient", initializeClient);

function initializePlatformCache() {
  const ctx = new DefaultStatefulContext();
  const memory = new MemoryStore({ persistentMap: new Map() });
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
  });

  return cache;
}

const platformCache = singleton("platformCache", initializePlatformCache);

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

    const currentRunCount = await $replica.jobRun.count({
      where: {
        organizationId: orgId,
        createdAt: {
          gte: firstDayOfMonth,
        },
      },
    });

    if (!result.success) {
      logger.error("Error getting current plan", { orgId, error: result.error });
      return undefined;
    }

    const periodStart = firstDayOfMonth;
    const periodEnd = firstDayOfNextMonth;
    const periodRemainingDuration = periodEnd.getTime() - new Date().getTime();

    const usage = {
      currentRunCount,
      runCountCap: result.subscription?.plan.runs?.freeAllowance,
      exceededRunCount: result.subscription?.plan.runs?.freeAllowance
        ? currentRunCount > result.subscription?.plan.runs?.freeAllowance
        : false,
      periodStart,
      periodEnd,
      periodRemainingDuration,
    };

    return { ...result, usage };
  } catch (e) {
    logger.error("Error getting current plan", { orgId, error: e });
    return undefined;
  }
}

export async function getLimits(orgId: string) {
  if (!client) return undefined;

  try {
    const result = await client.currentPlan(orgId);
    if (!result.success) {
      logger.error("Error getting limits", { orgId, error: result.error });
      return undefined;
    }

    return result.v3Subscription?.plan?.limits;
  } catch (e) {
    logger.error("Error getting limits", { orgId, error: e });
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
    logger.error("Error getting customer portal Url", { orgId, error: e });
    return undefined;
  }
}

export async function getPlans() {
  if (!client) return undefined;

  try {
    const result = await client.plans();
    if (!result.success) {
      logger.error("Error getting plans", { error: result.error });
      return undefined;
    }
    return result;
  } catch (e) {
    logger.error("Error getting plans", { error: e });
    return undefined;
  }
}

export async function setPlan(
  organization: { id: string; slug: string },
  request: Request,
  callerPath: string,
  plan: SetPlanBody
) {
  if (!client) {
    throw redirectWithErrorMessage(callerPath, request, "Error setting plan");
  }

  try {
    const result = await client.setPlan(organization.id, plan);

    if (!result) {
      throw redirectWithErrorMessage(callerPath, request, "Error setting plan");
    }

    if (!result.success) {
      throw redirectWithErrorMessage(callerPath, request, result.error);
    }

    switch (result.action) {
      case "free_connect_required": {
        return redirect(result.connectUrl);
      }
      case "free_connected": {
        if (result.accepted) {
          return redirect(newProjectPath(organization, "You're on the Free plan."));
        } else {
          return redirectWithErrorMessage(
            callerPath,
            request,
            "Free tier unlock failed, your GitHub account is too new."
          );
        }
      }
      case "create_subscription_flow_start": {
        return redirect(result.checkoutUrl);
      }
      case "updated_subscription": {
        return redirectWithSuccessMessage(
          callerPath,
          request,
          "Subscription updated successfully."
        );
      }
      case "canceled_subscription": {
        return redirectWithSuccessMessage(callerPath, request, "Subscription canceled.");
      }
    }
  } catch (e) {
    logger.error("Error setting plan", { organizationId: organization.id, error: e });
    throw redirectWithErrorMessage(
      callerPath,
      request,
      e instanceof Error ? e.message : "Error setting plan"
    );
  }
}

export async function getUsage(organizationId: string, { from, to }: { from: Date; to: Date }) {
  if (!client) return undefined;

  try {
    const result = await client.usage(organizationId, { from, to });
    if (!result.success) {
      logger.error("Error getting usage", { error: result.error });
      return undefined;
    }
    return result;
  } catch (e) {
    logger.error("Error getting usage", { error: e });
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
      logger.error("Error getting usage series", { error: result.error });
      return undefined;
    }
    return result;
  } catch (e) {
    logger.error("Error getting usage series", { error: e });
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
      logger.error("Error reporting invocation", { error: result.error });
      return undefined;
    }
    return result;
  } catch (e) {
    logger.error("Error reporting invocation", { error: e });
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

export async function getEntitlement(organizationId: string) {
  if (!client) return undefined;

  try {
    const result = await client.getEntitlement(organizationId);
    if (!result.success) {
      logger.error("Error getting entitlement", { error: result.error });
      return {
        hasAccess: true as const,
      };
    }
    return result;
  } catch (e) {
    logger.error("Error getting entitlement", { error: e });
    return {
      hasAccess: true as const,
    };
  }
}

export async function projectCreated(organization: Organization, project: Project) {
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
