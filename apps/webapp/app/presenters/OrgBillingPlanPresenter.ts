import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { BillingService } from "../services/billing.server";

export class OrgBillingPlanPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ slug }: { slug: string }) {
    const billingPresenter = new BillingService(true);
    return billingPresenter.getPlans();
  }
}
