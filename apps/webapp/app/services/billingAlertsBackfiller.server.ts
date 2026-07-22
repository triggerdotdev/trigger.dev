import { tryCatch } from "@trigger.dev/core";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  billingAlertsLookUnconfigured,
  buildDefaultBillingAlerts,
} from "~/services/billingAlertsDefaults.server";
import { getBillingAlerts, getBillingLimit, setBillingAlert } from "~/services/platform.v3.server";

export type BillingAlertsBackfillResult = {
  orgCount: number;
  seeded: number;
  skipped: number;
  failed: number;
  /** Pass back as `cursor` to continue; undefined when done. */
  cursor: string | undefined;
};

/** Seeds default billing alerts for orgs that have none configured. */
export async function backfillBillingAlerts({
  cursor,
  batchSize = 50,
  dryRun = false,
}: {
  cursor?: string;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<BillingAlertsBackfillResult> {
  const orgs = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: batchSize,
    select: { id: true, slug: true },
  });

  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const org of orgs) {
    const [alertsError, alerts] = await tryCatch(getBillingAlerts(org.id));
    if (alertsError || !alerts) {
      logger.warn("backfillBillingAlerts: failed to get alerts, skipping org", {
        organizationId: org.id,
        error: alertsError instanceof Error ? alertsError.message : alertsError,
      });
      failed++;
      continue;
    }

    if (!billingAlertsLookUnconfigured(alerts)) {
      skipped++;
      continue;
    }

    // Absolute-dollar defaults only apply when no billing limit is configured.
    const [limitError, billingLimit] = await tryCatch(getBillingLimit(org.id));
    if (limitError || !billingLimit) {
      logger.warn("backfillBillingAlerts: failed to get billing limit, skipping org", {
        organizationId: org.id,
        error: limitError instanceof Error ? limitError.message : limitError,
      });
      failed++;
      continue;
    }

    if (billingLimit.isConfigured && billingLimit.mode !== "none") {
      skipped++;
      continue;
    }

    const defaults = buildDefaultBillingAlerts();

    if (dryRun) {
      logger.info("backfillBillingAlerts: would seed defaults (dry run)", {
        organizationId: org.id,
        slug: org.slug,
        defaults,
      });
      seeded++;
      continue;
    }

    const [seedError] = await tryCatch(setBillingAlert(org.id, defaults));
    if (seedError) {
      logger.warn("backfillBillingAlerts: failed to seed defaults, skipping org", {
        organizationId: org.id,
        error: seedError instanceof Error ? seedError.message : seedError,
      });
      failed++;
      continue;
    }

    seeded++;
  }

  return {
    orgCount: orgs.length,
    seeded,
    skipped,
    failed,
    cursor: orgs.length === batchSize ? orgs[orgs.length - 1].id : undefined,
  };
}
