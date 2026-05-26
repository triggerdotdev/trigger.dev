import { deserialiseSnapshot, type MollifierBuffer } from "@trigger.dev/redis-worker";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

export type BufferedRunRedirectInfo = {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  spanId: string | undefined;
};

export type FindBufferedRunRedirectInfoDeps = {
  getBuffer?: () => MollifierBuffer | null;
  prismaClient?: PrismaClientOrTransaction;
};

// Resolve the org/project/env slugs needed to build the canonical run-detail
// URL for a buffered run. Used by the short-URL redirect routes
// (`runs.$runParam`, `@.runs.$runParam`, `projects.v3.$projectRef.runs.$runParam`)
// so a customer clicking the trigger-API-returned run link doesn't 404
// during the buffered window.
//
// Authorisation: PG query confirms the requesting user belongs to the
// organisation the buffer entry says owns the run. Without this check a
// known runId would leak slugs.
export async function findBufferedRunRedirectInfo(
  args: {
    runFriendlyId: string;
    userId: string;
    // Admin impersonation paths bypass org-membership; mirrors the existing
    // PG-side admin route behaviour (`@.runs.$runParam` doesn't filter by
    // org membership in the PG query either).
    skipOrgMembershipCheck?: boolean;
  },
  deps: FindBufferedRunRedirectInfoDeps = {},
): Promise<BufferedRunRedirectInfo | null> {
  const buffer = (deps.getBuffer ?? getMollifierBuffer)();
  const prismaClient = deps.prismaClient ?? prisma;
  if (!buffer) return null;

  let entry;
  try {
    entry = await buffer.getEntry(args.runFriendlyId);
  } catch (err) {
    logger.warn("buffered redirect: buffer.getEntry failed", {
      runFriendlyId: args.runFriendlyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!entry) return null;

  if (!args.skipOrgMembershipCheck) {
    const member = await prismaClient.orgMember.findFirst({
      where: { userId: args.userId, organizationId: entry.orgId },
      select: { id: true },
    });
    if (!member) return null;
  }

  let snapshot: Record<string, unknown>;
  try {
    snapshot = deserialiseSnapshot(entry.payload) as Record<string, unknown>;
  } catch (err) {
    logger.warn("buffered redirect: snapshot deserialise failed", {
      runFriendlyId: args.runFriendlyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const environment = snapshot.environment as Record<string, unknown> | undefined;
  if (!environment || typeof environment !== "object") return null;
  const project = environment.project as Record<string, unknown> | undefined;
  const organization = environment.organization as Record<string, unknown> | undefined;

  const envSlug = environment.slug;
  const projectSlug = project?.slug;
  const orgSlug = organization?.slug;
  if (typeof envSlug !== "string" || typeof projectSlug !== "string" || typeof orgSlug !== "string") {
    return null;
  }

  return {
    organizationSlug: orgSlug,
    projectSlug,
    environmentSlug: envSlug,
    spanId: typeof snapshot.spanId === "string" ? snapshot.spanId : undefined,
  };
}
