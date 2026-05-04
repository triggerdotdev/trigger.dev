import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { isPerOrgBasinsEnabled } from "~/services/realtime/streamBasinProvisioner.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { logger } from "~/services/logger.server";

/**
 * Backfill: enqueue `v3.reconcileStreamBasinForOrg` for every
 * non-deleted org. Idempotent. Page through `>limit` orgs by passing
 * `afterOrgId` from the previous response's `nextAfterOrgId`.
 */

const BodySchema = z
  .object({
    dryRun: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(10_000).optional().default(1000),
    afterOrgId: z.string().optional(),
  })
  .strict();

type BackfillResponse = {
  ok: true;
  dryRun: boolean;
  enqueued: number;
  pending: number;
  remaining: number;
  orgIds: string[];
  nextAfterOrgId: string | null;
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

  const { dryRun, limit, afterOrgId } = parsed;

  // Reconcile is fast for the no-op case, so we enqueue for all orgs
  // rather than filter on plan here.
  const candidates = await prisma.organization.findMany({
    where: { deletedAt: null },
    orderBy: { id: "asc" },
    take: limit,
    ...(afterOrgId ? { cursor: { id: afterOrgId }, skip: 1 } : {}),
    select: { id: true },
  });

  const lastReturnedId = candidates[candidates.length - 1]?.id;
  const nextAfterOrgId = candidates.length === limit && lastReturnedId ? lastReturnedId : null;

  const remaining = lastReturnedId
    ? await prisma.organization.count({
        where: { deletedAt: null, id: { gt: lastReturnedId } },
      })
    : 0;

  if (dryRun) {
    const response: BackfillResponse = {
      ok: true,
      dryRun: true,
      enqueued: 0,
      pending: candidates.length,
      remaining,
      orgIds: candidates.map((o) => o.id),
      nextAfterOrgId,
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
    remaining,
    orgIds: candidates.map((o) => o.id),
    nextAfterOrgId,
  };

  logger.info("[stream-basins-backfill] enqueued reconcile jobs", {
    enqueued,
    candidates: candidates.length,
    remaining: response.remaining,
  });

  return json(response);
}

// GET: read-only progress — orgs with vs without a basin stamped.
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
