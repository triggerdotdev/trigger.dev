import {
  Prisma,
  type PrismaClient,
  type PrismaClientOrTransaction,
  type RuntimeEnvironment,
} from "@trigger.dev/database";
import { $transaction } from "~/db.server";
import {
  PREVIEW_AUTO_ARCHIVE_DAY_MS,
  PreviewAutoArchivePolicy,
  classifyPreviewBranch,
  type PreviewBranchActivity,
} from "~/utils/previewAutoArchive";
import { archiveBranchesMutation } from "./branchArchiveMutation.server";
import { logger } from "./logger.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { trail } from "agentcrumbs"; // @crumbs

const crumb = trail("webapp"); // @crumbs
const PREVIEW_ARCHIVE_PAGE_SIZE = 100;
const PREVIEW_ARCHIVE_LANES = 4;
const PREVIEW_LIMIT = 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const RETRY_MS = 5 * 60 * 1_000;
const MAX_PAGES_PER_TICK = 100;
const TICK_BUDGET_MS = 20_000;

/** One bounded activity read shared by the list, settings preview, and cleanup. */
export async function previewBranchActivity(prisma: PrismaClientOrTransaction, ids: string[]) {
  if (ids.length > PREVIEW_LIMIT) throw new Error("Branch activity batch exceeds 1000 branches");
  if (!ids.length) return new Map<string, PreviewBranchActivity>();
  // Prisma cannot express these per-branch LATERAL LIMIT 1 lookups in one query.
  // unnest supplies the bounded IDs; the existing deployment indexes find the latest
  // attempt and any active attempt without loading history or issuing per-branch queries.
  const rows = await prisma.$queryRaw<Array<PreviewBranchActivity & { id: string }>>`
    SELECT b.id, latest."createdAt" AS "lastDeploymentAt", (active.found IS NOT NULL) AS "inProgress"
    FROM unnest(${ids}::text[]) AS b(id)
    LEFT JOIN LATERAL (
      SELECT d."createdAt" FROM "WorkerDeployment" d WHERE d."environmentId" = b.id
      ORDER BY d."createdAt" DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT true AS found FROM "WorkerDeployment" d WHERE d."environmentId" = b.id
        AND d.status IN ('PENDING', 'INSTALLING', 'BUILDING', 'DEPLOYING') LIMIT 1
    ) active ON true
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

export function isPreviewAutoArchiveEnabled(
  prisma: PrismaClientOrTransaction,
  organizationFlags: unknown
) {
  return makeFlag(prisma)({
    key: FEATURE_FLAG.previewAutoArchiveEnabled,
    defaultValue: false,
    overrides:
      organizationFlags &&
      typeof organizationFlags === "object" &&
      !Array.isArray(organizationFlags)
        ? (organizationFlags as Record<string, unknown>)
        : undefined,
  });
}

type DuePolicy = {
  id: string;
  previewAutoArchiveAfterDays: number;
  previewAutoArchiveExcludedBranches: string[];
  previewAutoArchiveNextCheckAt: Date;
  previewAutoArchiveCursorCreatedAt: Date | null;
  previewAutoArchiveCursorId: string | null;
  projectDeletedAt: Date | null;
  organizationDeletedAt: Date | null;
  organizationFlags: Prisma.JsonValue;
};

type ArchiveBranch = Pick<RuntimeEnvironment, "id" | "slug" | "branchName" | "createdAt">;

/** Claim one configured preview root using RuntimeEnvironment_preview_archive_due_idx. */
function previewArchiveDueQuery(now: Date) {
  // Prisma cannot express FOR UPDATE SKIP LOCKED. Claim and read the next due policy
  // together so concurrent workers take different roots. OF e locks only the environment,
  // while the joins provide tenant deletion and rollout state without extra lookups.
  return Prisma.sql`
    SELECT e.id, e."previewAutoArchiveAfterDays", e."previewAutoArchiveExcludedBranches",
      e."previewAutoArchiveNextCheckAt", e."previewAutoArchiveCursorCreatedAt", e."previewAutoArchiveCursorId",
      p."deletedAt" AS "projectDeletedAt", o."deletedAt" AS "organizationDeletedAt",
      o."featureFlags" AS "organizationFlags"
    FROM "RuntimeEnvironment" e
    JOIN "Project" p ON p.id = e."projectId"
    JOIN "Organization" o ON o.id = e."organizationId"
    WHERE e.type = 'PREVIEW' AND e."parentEnvironmentId" IS NULL
      AND e."isBranchableEnvironment" = true AND e."archivedAt" IS NULL
      AND e."previewAutoArchiveAfterDays" IS NOT NULL
      AND e."previewAutoArchiveNextCheckAt" IS NOT NULL AND e."previewAutoArchiveNextCheckAt" <= ${now}
    ORDER BY e."previewAutoArchiveNextCheckAt", e.id
    LIMIT 1 FOR UPDATE OF e SKIP LOCKED
  `;
}

export async function previewAutoArchiveCount(
  prisma: PrismaClient,
  parentId: string,
  days: number,
  exclusions: string[],
  now = new Date()
) {
  const result = await $transaction(
    prisma,
    "previewAutoArchiveCount",
    async (tx) => {
      const branches = await tx.runtimeEnvironment.findMany({
        where: {
          parentEnvironmentId: parentId,
          type: "PREVIEW",
          archivedAt: null,
          branchName: { not: null },
        },
        select: { id: true, branchName: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: PREVIEW_LIMIT + 1,
      });
      const sample = branches.slice(0, PREVIEW_LIMIT);
      const activity = await previewBranchActivity(
        tx,
        sample.map(({ id }) => id)
      );
      const excluded = new Set(exclusions);
      const result = {
        count: 0,
        scheduled: 0,
        inProgress: 0,
        protectedBranches: [] as string[],
        partial: branches.length > PREVIEW_LIMIT,
      };
      for (const branch of sample) {
        const { status } = classifyPreviewBranch(
          branch,
          activity.get(branch.id)!,
          days,
          excluded,
          now
        );
        switch (status) {
          case "protected":
            result.protectedBranches.push(branch.branchName!);
            break;
          case "inProgress":
            result.inProgress++;
            break;
          case "ready":
            result.count++;
            break;
          case "scheduled":
            result.scheduled++;
            break;
        }
      }
      return result;
    },
    { timeout: 5_000, maxWait: 1_000 }
  );
  if (!result) throw new Error("Failed to preview automatic archiving");
  return result;
}

/** The route has already enforced membership and write permission. One row update
 * changes policy and scheduling together, serializing with an executing page. */
export async function savePreviewAutoArchivePolicy(
  prisma: PrismaClient,
  parentId: string,
  input: { days: number | null; excludedBranches: string[] },
  now = new Date()
) {
  const { days, excludedBranches } = PreviewAutoArchivePolicy.parse(input);
  await prisma.runtimeEnvironment.update({
    where: {
      id: parentId,
      type: "PREVIEW",
      parentEnvironmentId: null,
      isBranchableEnvironment: true,
      archivedAt: null,
    },
    data: {
      previewAutoArchiveAfterDays: days,
      previewAutoArchiveExcludedBranches: excludedBranches,
      previewAutoArchiveNextCheckAt: days === null ? null : now,
      previewAutoArchiveCursorCreatedAt: null,
      previewAutoArchiveCursorId: null,
    },
  });
}

/** At most four database pages globally, even with duplicate jobs or many webapp
 * instances. Advisory locks are transaction-scoped: no lease TTL or orphan recovery. */
export async function processPreviewAutoArchivePage(
  prisma: PrismaClient,
  lane: number,
  now = new Date()
) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= PREVIEW_ARCHIVE_LANES)
    throw new Error("Invalid archive lane");
  let claimed: DuePolicy | undefined;
  const started = performance.now();
  try {
    const result = await $transaction(
      prisma,
      "processPreviewAutoArchivePage",
      async (tx) => {
        // PostgreSQL advisory locks cap concurrent cleanup pages across all app instances;
        // an in-process limiter would not. Prisma has no advisory-lock API. The try form
        // returns immediately when occupied, and the lock is released with this transaction.
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('preview-branch-auto-archive'), ${lane}::int) AS acquired
      `;
        if (!lock.acquired) return null;
        // Execute the atomic policy claim defined above; Prisma findFirst cannot hold
        // the SKIP LOCKED row claim through archiving and cursor advancement.
        const [parent] = await tx.$queryRaw<DuePolicy[]>(previewArchiveDueQuery(now));
        if (!parent) return null;
        claimed = parent;
        if (parent.projectDeletedAt || parent.organizationDeletedAt) {
          await tx.runtimeEnvironment.update({
            where: { id: parent.id },
            data: {
              previewAutoArchiveNextCheckAt: null,
              previewAutoArchiveCursorCreatedAt: null,
              previewAutoArchiveCursorId: null,
            },
          });
          return { parentId: parent.id, scanned: 0, candidates: 0, archived: [], complete: true };
        }
        if (!(await isPreviewAutoArchiveEnabled(tx, parent.organizationFlags))) {
          crumb("preview archive rollout disabled", { parentId: parent.id }); // @crumbs
          // Keep durable progress and policy for re-enablement, without rescanning a
          // disabled organization on every tick or starving other due projects.
          await tx.runtimeEnvironment.update({
            where: { id: parent.id },
            data: { previewAutoArchiveNextCheckAt: new Date(now.getTime() + HOUR_MS) },
          });
          return { parentId: parent.id, scanned: 0, candidates: 0, archived: [], complete: true };
        }
        const cutoff = new Date(
          now.getTime() - parent.previewAutoArchiveAfterDays * PREVIEW_AUTO_ARCHIVE_DAY_MS
        );
        const cursorCreatedAt = parent.previewAutoArchiveCursorCreatedAt;
        const cursorId = parent.previewAutoArchiveCursorId;
        // A tuple comparison seeks directly into the (parentEnvironmentId, createdAt, id)
        // index. Prisma's equivalent OR filter can rescan earlier IDs sharing the timestamp.
        const scanned = await tx.$queryRaw<Array<Omit<ArchiveBranch, "slug">>>`
          SELECT id, "branchName", "createdAt" FROM "RuntimeEnvironment"
          WHERE "parentEnvironmentId" = ${parent.id} AND type = 'PREVIEW'
            AND "archivedAt" IS NULL AND "branchName" IS NOT NULL
            AND "createdAt" <= ${cutoff}
            ${
              cursorCreatedAt && cursorId
                ? Prisma.sql`AND ("createdAt", id) > (${cursorCreatedAt}, ${cursorId})`
                : Prisma.empty
            }
          ORDER BY "createdAt", id
          LIMIT ${PREVIEW_ARCHIVE_PAGE_SIZE}
        `;
        const excluded = new Set(parent.previewAutoArchiveExcludedBranches);
        const ids = scanned
          .filter(({ branchName }) => !excluded.has(branchName!))
          .map(({ id }) => id);
        let eligible: ArchiveBranch[] = [];
        if (ids.length) {
          // Prisma cannot express FOR UPDATE SKIP LOCKED. Share the deployment row lock
          // before checking activity, skipping busy branches instead of waiting. Read the
          // current slug under that lock and omit rows a manual archive already archived.
          const locked = await tx.$queryRaw<ArchiveBranch[]>`
            SELECT id, slug, "branchName", "createdAt" FROM "RuntimeEnvironment"
            WHERE id = ANY(${ids}::text[]) AND "archivedAt" IS NULL
            ORDER BY id FOR UPDATE SKIP LOCKED
          `;
          // A separate READ COMMITTED statement sees deployments committed before
          // these locks. No eligibility query is needed before acquiring the locks.
          const activity = await previewBranchActivity(
            tx,
            locked.map(({ id }) => id)
          );
          eligible = locked.filter(
            (branch) =>
              classifyPreviewBranch(
                branch,
                activity.get(branch.id)!,
                parent.previewAutoArchiveAfterDays,
                excluded,
                now
              ).status === "ready"
          );
        }
        const archived = await archiveBranchesMutation(tx, eligible, now);
        const complete = scanned.length < PREVIEW_ARCHIVE_PAGE_SIZE;
        const last = scanned[scanned.length - 1];
        await tx.runtimeEnvironment.update({
          where: { id: parent.id },
          data: {
            previewAutoArchiveNextCheckAt: complete ? new Date(now.getTime() + HOUR_MS) : now,
            previewAutoArchiveCursorCreatedAt: complete ? null : last.createdAt,
            previewAutoArchiveCursorId: complete ? null : last.id,
          },
        });
        // #region @crumbs
        crumb("preview archive page", {
          parentId: parent.id,
          scanned: scanned.length,
          archived: archived.length,
        });
        // #endregion @crumbs
        return {
          parentId: parent.id,
          scanned: scanned.length,
          candidates: ids.length,
          archived,
          complete,
        };
      },
      { isolationLevel: "ReadCommitted", timeout: 5_000, maxWait: 1_000 }
    );
    if (result)
      logger.debug("Preview archive page completed", {
        parentId: result.parentId,
        scanned: result.scanned,
        candidates: result.candidates,
        archived: result.archived.length,
        durationMs: performance.now() - started,
      });
    return result ?? null;
  } catch (error) {
    if (claimed) {
      // The page (including archives and cursor) rolled back. Conditional backoff
      // cannot overwrite a subsequent successful page or a user's policy change.
      await $transaction(
        prisma,
        "backoffPreviewAutoArchive",
        async (tx) => {
          await tx.runtimeEnvironment.updateMany({
            where: {
              id: claimed!.id,
              previewAutoArchiveNextCheckAt: claimed!.previewAutoArchiveNextCheckAt,
              previewAutoArchiveCursorCreatedAt: claimed!.previewAutoArchiveCursorCreatedAt,
              previewAutoArchiveCursorId: claimed!.previewAutoArchiveCursorId,
            },
            data: { previewAutoArchiveNextCheckAt: new Date(now.getTime() + RETRY_MS) },
          });
        },
        { timeout: 5_000, maxWait: 1_000 }
      );
    }
    throw error;
  }
}

/** Every tick rediscovers due pages from Postgres. No Redis continuation can be
 * lost between committing a page and scheduling the next one. */
export async function sweepPreviewAutoArchives(
  prisma: PrismaClient,
  onArchived: (ids: string[]) => void
) {
  const started = performance.now();
  let admitted = 0;
  let pages = 0;
  let scanned = 0;
  let archived = 0;
  let failures = 0;
  await Promise.all(
    Array.from({ length: PREVIEW_ARCHIVE_LANES }, async (_, lane) => {
      while (admitted < MAX_PAGES_PER_TICK && performance.now() - started < TICK_BUDGET_MS) {
        admitted++;
        try {
          const result = await processPreviewAutoArchivePage(prisma, lane);
          if (!result) break;
          pages++;
          scanned += result.scanned;
          archived += result.archived.length;
          onArchived(result.archived.map(({ id }) => id));
        } catch (error) {
          failures++;
          logger.error("Preview auto-archive page failed", { error });
          // Don't spin on database acquisition failures; the next tick retries.
          break;
        }
      }
    })
  );
  const stats = { pages, scanned, archived, failures, durationMs: performance.now() - started };
  if (pages || failures) logger.info("Preview auto-archive sweep", stats);
  return stats;
}
