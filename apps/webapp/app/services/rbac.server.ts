import { $replica, prisma } from "~/db.server";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { env } from "~/env.server";

// plugin.create() is synchronous — returns a lazy controller that resolves
// any installed RBAC plugin on first call. Top-level await is not used
// because CJS output format does not support it.
//
// Auth-path reads run on every request — pass the replica explicitly so
// they don't pile up on the primary. Writes (role mutations) still go
// through the primary. Same separation findEnvironmentByApiKey used
// before this PR moved bearer auth into the RBAC plugin.
//
// Session-cookie userId resolution lives at the call site (see
// dashboardBuilder.server.ts), not here. Statically importing
// `~/services/session.server` from this module dragged the entire
// remix-auth pipeline (auth.server → emailAuth/gitHubAuth/googleAuth,
// each validating their secret at module load) into anything that
// transitively imported `rbac` — including PAT auth callers that have
// no session-cookie path at all. Passing userId through the
// `authenticateSession` context decouples the plugin host from the
// host's session implementation.
export const rbac = plugin.create(
  // $replica is structurally a PrismaClient minus `$transaction` — the
  // RBAC fallback only uses `findFirst` on it, so the cast is safe.
  { primary: prisma, replica: $replica as PrismaClient },
  { forceFallback: env.RBAC_FORCE_FALLBACK }
);
