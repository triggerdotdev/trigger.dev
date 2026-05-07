import { $replica, prisma } from "~/db.server";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { env } from "~/env.server";
import { getUserId } from "./session.server";

async function getSessionUserId(request: Request): Promise<string | null> {
  const id = await getUserId(request);
  return id ?? null;
}

// plugin.create() is synchronous — returns a lazy controller that resolves
// any installed RBAC plugin on first call. Top-level await is not used
// because CJS output format does not support it.
//
// Auth-path reads run on every request — pass the replica explicitly so
// they don't pile up on the primary. Writes (role mutations) still go
// through the primary. Same separation findEnvironmentByApiKey used
// before this PR moved bearer auth into the RBAC plugin.
export const rbac = plugin.create(
  // $replica is structurally a PrismaClient minus `$transaction` — the
  // RBAC fallback only uses `findFirst` on it, so the cast is safe.
  { primary: prisma, replica: $replica as PrismaClient },
  { getSessionUserId },
  { forceFallback: env.RBAC_FORCE_FALLBACK }
);
