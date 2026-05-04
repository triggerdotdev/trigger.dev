import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { isPerOrgBasinsEnabled } from "~/services/realtime/streamBasinProvisioner.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { logger } from "~/services/logger.server";

/**
 * One-shot backfill that enqueues `v3.reconcileStreamBasinForOrg` for
 * every non-deleted org. The reconciler decides per-org what to do:
 * provision a basin for paid orgs that don't have one, reconfigure
 * retention for paid orgs whose tier changed, deprovision (null the
 * column) for free orgs that were mistakenly provisioned. Idempotent
 * — re-running converges to the desired state.
 *
 *  - Admin auth via `requireAdminApiRequest` (PAT in `Authorization`).
 *  - Refuses to run when `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=false`
 *    so OSS / s2-lite installs can't accidentally trigger basin
 *    operations against a misconfigured backend.
 *  - `dryRun=true` (default false) returns the count without enqueueing.
 *  - `limit` (default 1000, max 10000) caps a single invocation. Run
 *    again with the next batch.
 *  - Each job is keyed `reconcileStreamBasin:<orgId>` so concurrent
 *    calls converge to one job per org.
 */

const BodySchema = z
  .object({
    dryRun: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(10_000).optional().default(1000),
  })
  .strict();

type BackfillResponse = {
  ok: true;
  dryRun: boolean;
  enqueued: number;
  pending: number;
  remaining: number;
  orgIds: string[];
};

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (!isPerOrgBasinsEnabled()) {
    return json(
      {
        ok: false,
        error:
          "Per-org stream basins are disabled. Set REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=true before running the backfill.",
      },
      { status: 400 }
    );
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    const text = await request.text();
    const raw = text.length > 0 ? JSON.parse(text) : {};
    const result = BodySchema.safeParse(raw);
    if (!result.success) {
      return json({ ok: false, error: result.error.flatten() }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { dryRun, limit } = parsed;

  // Walk every non-deleted org. The reconcile worker is fast for the
  // no-op case (free with null column) so enqueueing for all is fine
  // — saves us from doing per-org billing lookups here just to filter
  // candidates.
  const candidates = await prisma.organization.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const totalOrgs = await prisma.organization.count({
    where: { deletedAt: null },
  });

  if (dryRun) {
    const response: BackfillResponse = {
      ok: true,
      dryRun: true,
      enqueued: 0,
      pending: candidates.length,
      remaining: Math.max(0, totalOrgs - candidates.length),
      orgIds: candidates.map((o) => o.id),
    };
    return json(response);
  }

  let enqueued = 0;
  for (const org of candidates) {
    try {
      await commonWorker.enqueue({
        job: "v3.reconcileStreamBasinForOrg",
        payload: { orgId: org.id },
        id: `reconcileStreamBasin:${org.id}`,
      });
      enqueued += 1;
    } catch (error) {
      logger.error("[stream-basins-backfill] enqueue failed", {
        orgId: org.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const response: BackfillResponse = {
    ok: true,
    dryRun: false,
    enqueued,
    pending: candidates.length,
    remaining: Math.max(0, totalOrgs - enqueued),
    orgIds: candidates.map((o) => o.id),
  };

  logger.info("[stream-basins-backfill] enqueued reconcile jobs", {
    enqueued,
    candidates: candidates.length,
    remaining: response.remaining,
  });

  return json(response);
}

// GET returns the current state without doing anything — useful for
// monitoring "is the backfill done yet?" from a dashboard / curl.
export async function loader({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const totalOrgs = await prisma.organization.count({ where: { deletedAt: null } });
  const withBasin = await prisma.organization.count({
    where: { deletedAt: null, NOT: { streamBasinName: null } },
  });

  return json({
    ok: true,
    perOrgBasinsEnabled: isPerOrgBasinsEnabled(),
    totalOrgs,
    withBasin,
    withoutBasin: totalOrgs - withBasin,
  });
}
