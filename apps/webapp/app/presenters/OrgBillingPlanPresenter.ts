import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { BillingPresenter } from "./BillingPresenter.server";

export class OrgBillingPlanPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ slug }: { slug: string }) {
    const billingPresenter = new BillingPresenter(true);
    return billingPresenter.getPlans();
  }
}
