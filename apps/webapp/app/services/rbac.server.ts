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
  // SESSION_SECRET signs delegated user-actor tokens; the plugin verifies
  // them with it in authenticateUserActor.
  {
    forceFallback: env.RBAC_FORCE_FALLBACK,
    userActorSecret: env.SESSION_SECRET,
    // A plugin that owns its own database client gets the same
    // writer/replica topology the webapp's Prisma clients use (see
    // getClient/getReplicaClient in db.server.ts): control-plane URLs win,
    // and with no replica configured reads share the writer.
    database: {
      writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
      readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
      writerConnectionLimit: env.RBAC_DATABASE_WRITER_CONNECTION_LIMIT,
      readerConnectionLimit: env.RBAC_DATABASE_READER_CONNECTION_LIMIT,
    },
  }
);
