import { $replica, prisma } from "~/db.server";
import type { PrismaClient } from "@trigger.dev/database";
import sso from "@trigger.dev/sso";
import { env } from "~/env.server";

// sso.create() is synchronous — returns a lazy controller that resolves
// any installed SSO plugin on first call. Top-level await is not used
// because the webapp's CJS build does not support it.
//
// Auth-path reads run on every login attempt — pass the replica
// explicitly so they don't pile up on the primary. Writes (config
// mutations) still go through the primary.
export const ssoController = sso.create(
  // $replica is structurally a PrismaClient minus `$transaction`. The
  // fallback only uses `findFirst` on it, so the cast is safe.
  { primary: prisma, replica: $replica as PrismaClient },
  // SSO_ENABLED is the deploy gate: until it's on, force the OSS
  // fallback so the entire SSO surface (login, settings, callback,
  // re-validation) stays inert. SSO_FORCE_FALLBACK remains an
  // independent contributor/debug override.
  {
    forceFallback: !env.SSO_ENABLED || env.SSO_FORCE_FALLBACK,
    // A plugin that owns its own database client gets the same
    // writer/replica topology the webapp's Prisma clients use (see
    // getClient/getReplicaClient in db.server.ts): control-plane URLs win,
    // and with no replica configured reads share the writer.
    database: {
      writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
      readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
      writerConnectionLimit: env.SSO_DATABASE_WRITER_CONNECTION_LIMIT,
      readerConnectionLimit: env.SSO_DATABASE_READER_CONNECTION_LIMIT,
    },
  }
);
