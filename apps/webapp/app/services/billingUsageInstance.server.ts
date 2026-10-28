import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { billingPlugin } from "~/services/billingPlugin.server";
import { createBillingUsageService } from "~/services/billingUsage.server";

type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  externalRef: string;
  deletedAt: Date | null;
};

export const billingUsage = createBillingUsageService({
  enabled: env.BILLING_V2_ENABLED,
  controller: billingPlugin,
  findProjects: async (organizationId, projectIds) => {
    const rows = await $replica.$queryRaw<ProjectRow[]>`
      SELECT id, name, slug, "externalRef", "deletedAt"
      FROM "Project"
      WHERE id = ANY(${projectIds}) AND "organizationId" = ${organizationId}
    `;
    return rows.map(({ deletedAt, ...project }) => ({ ...project, deleted: deletedAt !== null }));
  },
});
