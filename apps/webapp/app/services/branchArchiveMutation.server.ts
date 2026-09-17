import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { nanoid } from "nanoid";

function archivedSlug(slug: string) {
  return `${slug}-${nanoid(6)}`;
}

/** Preserve history and release the original name for a new environment generation. */
export function archiveBranchMutation(
  prisma: PrismaClientOrTransaction,
  environment: { id: string; slug: string },
  archivedAt = new Date()
) {
  const slug = archivedSlug(environment.slug);
  return prisma.runtimeEnvironment.update({
    where: { id: environment.id, archivedAt: null },
    data: { archivedAt, slug, shortcode: slug },
  });
}

/** The caller has locked and rechecked these exact environment generations. */
export async function archiveBranchesMutation(
  prisma: PrismaClientOrTransaction,
  environments: Array<{ id: string; slug: string }>,
  archivedAt: Date
) {
  if (environments.length > 100) throw new Error("Archive batch exceeds 100 branches");
  if (!environments.length) return [];
  const ids = environments.map(({ id }) => id);
  const slugs = environments.map(({ slug }) => archivedSlug(slug));
  // Prisma updateMany applies identical values to every row; each archive needs its own
  // replacement slug. unnest pairs the bounded IDs and slugs for one UPDATE instead of
  // up to 100 writes while holding row locks. RETURNING identifies the archived rows
  // for cache invalidation without a separate read.
  return prisma.$queryRaw<Array<{ id: string; branchName: string; archivedAt: Date }>>`
    UPDATE "RuntimeEnvironment" e
    SET "archivedAt" = ${archivedAt}, "updatedAt" = ${archivedAt}, slug = batch.slug, shortcode = batch.slug
    FROM unnest(${ids}::text[], ${slugs}::text[]) AS batch(id, slug)
    WHERE e.id = batch.id AND e."archivedAt" IS NULL
    RETURNING e.id, e."branchName", e."archivedAt"
  `;
}
