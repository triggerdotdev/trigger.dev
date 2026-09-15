import { z } from "zod";
import { convergeBillingLimitEnvironmentsForOrg } from "./billingLimitConvergeEnvironments.server";
import { runBillingLimitReconcileTick } from "./runBillingLimitReconcileTick.server";
import { seedBillingLimitReconcileQueue } from "./billingLimitReconcileQueue.server";

const ConvergePayloadSchema = z.object({
  organizationId: z.string(),
  targetState: z.enum(["grace", "rejected", "ok"]),
});

export class BillingLimitConvergeEnvironmentsService {
  static async seedReconcileQueue(organizationId: string) {
    await seedBillingLimitReconcileQueue(organizationId);
  }

  static async runConverge(payload: z.infer<typeof ConvergePayloadSchema>) {
    const parsed = ConvergePayloadSchema.parse(payload);
    return convergeBillingLimitEnvironmentsForOrg(parsed.organizationId, parsed.targetState);
  }

  static async runReconcileTick() {
    await runBillingLimitReconcileTick();
  }
}
