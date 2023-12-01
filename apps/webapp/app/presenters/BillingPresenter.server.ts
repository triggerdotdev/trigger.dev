import { BillingClient } from "@trigger.dev/billing";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

export class BillingPresenter {
  #billingClient: BillingClient | undefined;
  #prismaClient: PrismaClient;

  constructor(isManagedCloud: boolean, prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
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

  async currentPlan(orgId: string) {
    if (!this.#billingClient) return undefined;
    try {
      const result = await this.#billingClient.currentPlan(orgId);

      const firstDayOfMonth = new Date();
      firstDayOfMonth.setDate(1);
      firstDayOfMonth.setHours(0, 0, 0, 0);

      console.log("firstDayOfMonth", firstDayOfMonth);

      const currentRunCount = await this.#prismaClient.jobRun.count({
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

      const usage = {
        currentRunCount,
        runCountCap: result.subscription?.plan.runs?.freeAllowance,
        exceededRunCount: result.subscription?.plan.runs?.freeAllowance
          ? currentRunCount > result.subscription?.plan.runs?.freeAllowance
          : false,
      };

      return { ...result, usage };
    } catch (e) {
      logger.error("Error getting current plan", { orgId, error: e });
      return undefined;
    }
  }
}
