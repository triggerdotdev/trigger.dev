import billing from "@trigger.dev/billing";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { provisionBillingCustomerForNewOrg } from "~/services/provisionBillingCustomer.server";

const billingEnabled = env.BILLING_PLUGIN_ENABLED && !env.BILLING_FORCE_FALLBACK;

const billingPlugin = billing.create({
  forceFallback: !billingEnabled,
  database: {
    writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
    writerConnectionLimit: env.BILLING_DATABASE_CONNECTION_LIMIT,
    readerConnectionLimit: env.BILLING_DATABASE_CONNECTION_LIMIT,
  },
});

export function provisionBillingCustomerForOrg(organizationId: string): Promise<void> {
  return provisionBillingCustomerForNewOrg(organizationId, {
    enabled: billingEnabled,
    controller: billingPlugin,
    deleteOrganization: async (id) => {
      await prisma.organization.delete({ where: { id } });
    },
  });
}
