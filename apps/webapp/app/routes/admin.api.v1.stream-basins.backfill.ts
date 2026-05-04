import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { isPerOrgBasinsEnabled } from "~/services/realtime/streamBasinProvisioner.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { logger } from "~/services/logger.server";

/**
 * One-shot backfill that enqueues `v3.provisionStreamBasinForOrg` for
 * every org with `streamBasinName: null`. Idempotent — re-running picks
 * up only the orgs that haven't been provisioned yet, and the worker
 * job itself is also idempotent (the provisioner short-circuits if the
 * org column is already set).
 *
 *  - Admin auth via `requireAdminApiRequest` (PAT in `Authorization`).
 *  - Refuses to run when `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=false`
 *    so OSS / s2-lite installs can't accidentally trigger basin
 *    creation against a misconfigured backend.
 *  - `dryRun=true` (default false) returns the count without enqueueing.
 *  - `limit` (default 1000, max 10000) caps a single invocation. Run
 *    again to process more — the column filter naturally walks the
 *    queue forward each call.
 *  - Each job is keyed `provisionStreamBasin:<orgId>` so concurrent
 *    backfill calls converge to one job per org instead of duplicating.
 *
 * Run from a shell:
 *   curl -X POST -H "Authorization: Bearer $PAT" \
 *     "https://api.trigger.dev/admin/api/v1/stream-basins/backfill?limit=200&dryRun=true"
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

  // `application/json` POST body — empty body falls back to defaults so
  // a parameterless POST does the right thing for the default backfill.
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

  // Page candidate orgs. Ordered by createdAt so re-runs walk the queue
  // forward predictably; deletedAt filter avoids resurrecting orgs.
  const candidates = await prisma.organization.findMany({
    where: {
      streamBasinName: null,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  // Total count of remaining nulls (for progress reporting).
  const remainingTotal = await prisma.organization.count({
    where: { streamBasinName: null, deletedAt: null },
  });

  if (dryRun) {
    const response: BackfillResponse = {
      ok: true,
      dryRun: true,
      enqueued: 0,
      pending: candidates.length,
      remaining: Math.max(0, remainingTotal - candidates.length),
      orgIds: candidates.map((o) => o.id),
    };
    return json(response);
  }

  // Enqueue one job per org. Per-org dedupe key collapses concurrent
  // backfill calls into a single pending job, and a job that's already
  // run (basin set) is a no-op on the worker side.
  let enqueued = 0;
  for (const org of candidates) {
    try {
      await commonWorker.enqueue({
        job: "v3.provisionStreamBasinForOrg",
        payload: { orgId: org.id },
        id: `provisionStreamBasin:${org.id}`,
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
    remaining: Math.max(0, remainingTotal - enqueued),
    orgIds: candidates.map((o) => o.id),
  };

  logger.info("[stream-basins-backfill] enqueued provisioning jobs", {
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
  const provisioned = await prisma.organization.count({
    where: { deletedAt: null, NOT: { streamBasinName: null } },
  });
  const remaining = totalOrgs - provisioned;

  return json({
    ok: true,
    perOrgBasinsEnabled: isPerOrgBasinsEnabled(),
    totalOrgs,
    provisioned,
    remaining,
    completion: totalOrgs === 0 ? 1 : provisioned / totalOrgs,
  });
}
