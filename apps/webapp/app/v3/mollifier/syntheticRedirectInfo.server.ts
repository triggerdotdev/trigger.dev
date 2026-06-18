import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
// Use the webapp-side wrapper (not `deserialiseSnapshot` from
// @trigger.dev/redis-worker directly) so this file shares a single
// deserialisation path with readFallback.server.ts. The two are
// behaviourally identical today (both wrap `JSON.parse`), but pinning
// the shared helper keeps the two read-side modules from drifting if
// snapshot encoding ever changes.
import { deserialiseMollifierSnapshot } from "./mollifierSnapshot.server";

// Validated subset of a mollifier snapshot — just the fields needed to
// rebuild a canonical run-detail URL for a buffered run. Anything else
// in the payload is ignored. `safeParse` against this schema replaces
// the ad-hoc `as Record<string, unknown>` + `typeof === "string"` checks
// that the redirect path used to do by hand; missing or wrong-typed
// fields collapse into a single `parsed.success === false` branch.
const BufferedSnapshotSchema = z.object({
  spanId: z.string().optional(),
  environment: z.object({
    slug: z.string(),
    project: z.object({ slug: z.string() }),
    organization: z.object({ slug: z.string() }),
  }),
});

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

  let raw: unknown;
  try {
    raw = deserialiseMollifierSnapshot(entry.payload);
  } catch (err) {
    logger.warn("buffered redirect: snapshot deserialise failed", {
      runFriendlyId: args.runFriendlyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const parsed = BufferedSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    // Either the snapshot is from a different writer that doesn't carry
    // environment slugs (in which case we genuinely can't build a URL)
    // or a buffer-format drift snuck through. Log at debug; the caller
    // 404s and the user sees the standard not-found page, not a 500.
    logger.debug("buffered redirect: snapshot shape mismatch", {
      runFriendlyId: args.runFriendlyId,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    return null;
  }

  return {
    organizationSlug: parsed.data.environment.organization.slug,
    projectSlug: parsed.data.environment.project.slug,
    environmentSlug: parsed.data.environment.slug,
    spanId: parsed.data.spanId,
  };
}
