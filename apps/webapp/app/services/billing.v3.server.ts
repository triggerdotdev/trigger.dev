import { BillingClient, SetPlanBody } from "@trigger.dev/billing/v3";
import { $replica, PrismaClient, PrismaReplicaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { organizationBillingPath } from "~/utils/pathBuilder";

export class BillingService {
  #billingClient: BillingClient | undefined;
  #prismaClient: PrismaClient;
  #replica: PrismaReplicaClient;

  constructor(
    isManagedCloud: boolean,
    prismaClient: PrismaClient = prisma,
    replica: PrismaReplicaClient = $replica
  ) {
    this.#prismaClient = prismaClient;
    this.#replica = replica;
    if (isManagedCloud && process.env.BILLING_API_URL && process.env.BILLING_API_KEY) {
      this.#billingClient = new BillingClient({
        url: process.env.BILLING_API_URL,
        apiKey: process.env.BILLING_API_KEY,
      });
      console.log(`Billing client initialized: ${process.env.BILLING_API_URL}`);
    } else {
      console.log(`Billing client not initialized`);
    }
  }

  //todo
  // async currentPlan(orgId: string) {
  //   if (!this.#billingClient) return undefined;
  //   try {
  //     const result = await this.#billingClient.currentPlan(orgId);

  //     const firstDayOfMonth = new Date();
  //     firstDayOfMonth.setDate(1);
  //     firstDayOfMonth.setHours(0, 0, 0, 0);

  //     const firstDayOfNextMonth = new Date();
  //     firstDayOfNextMonth.setDate(1);
  //     firstDayOfNextMonth.setMonth(firstDayOfNextMonth.getMonth() + 1);
  //     firstDayOfNextMonth.setHours(0, 0, 0, 0);

  //     const currentRunCount = await this.#replica.jobRun.count({
  //       where: {
  //         organizationId: orgId,
  //         createdAt: {
  //           gte: firstDayOfMonth,
  //         },
  //       },
  //     });

  //     if (!result.success) {
  //       logger.error("Error getting current plan", { orgId, error: result.error });
  //       return undefined;
  //     }

  //     const periodStart = firstDayOfMonth;
  //     const periodEnd = firstDayOfNextMonth;
  //     const periodRemainingDuration = periodEnd.getTime() - new Date().getTime();

  //     const usage = {
  //       currentRunCount,
  //       runCountCap: result.subscription?.plan.runs?.freeAllowance,
  //       exceededRunCount: result.subscription?.plan.runs?.freeAllowance
  //         ? currentRunCount > result.subscription?.plan.runs?.freeAllowance
  //         : false,
  //       periodStart,
  //       periodEnd,
  //       periodRemainingDuration,
  //     };

  //     return { ...result, usage };
  //   } catch (e) {
  //     logger.error("Error getting current plan", { orgId, error: e });
  //     return undefined;
  //   }
  // }

  async customerPortalUrl(orgId: string, orgSlug: string) {
    if (!this.#billingClient) return undefined;
    try {
      return this.#billingClient.createPortalSession(orgId, {
        returnUrl: `${env.APP_ORIGIN}${organizationBillingPath({ slug: orgSlug })}`,
      });
    } catch (e) {
      logger.error("Error getting customer portal Url", { orgId, error: e });
      return undefined;
    }
  }

  async getPlans() {
    if (!this.#billingClient) return undefined;
    try {
      const result = await this.#billingClient.plans();
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

  async setPlan(orgId: string, plan: SetPlanBody) {
    if (!this.#billingClient) return undefined;
    try {
      const result = await this.#billingClient.setPlan(orgId, plan);
      return result;
    } catch (e) {
      logger.error("Error setting plan", { orgId, error: e });
      return undefined;
    }
  }
}
