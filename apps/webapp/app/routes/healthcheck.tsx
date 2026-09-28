import { prisma } from "~/db.server";
import type { LoaderFunction } from "@remix-run/node";
import { env } from "~/env.server";
import { rbac } from "~/services/rbac.server";
import { isOtlpWorkerPoolHealthy } from "~/v3/otlpWorkerPool.server";

export const loader: LoaderFunction = async ({ request }) => {
  try {
    // Resolve the lazy plugin controller so plugin-load failures surface
    // during readiness probes. With REQUIRE_PLUGINS=1, a failed plugin
    // load throws here and the rollout's readiness probe fails. The
    // fallback path doesn't touch the DB, so this runs even when
    // HEALTHCHECK_DATABASE_DISABLED=1 — REQUIRE_PLUGINS protection must
    // not be silently bypassed by the DB-disabled flag.
    await rbac.isUsingPlugin();

    if (env.OTEL_TRANSFORM_WORKER_POOL_ENABLED && !isOtlpWorkerPoolHealthy()) {
      console.log("healthcheck ❌ otlp worker pool has no alive workers");
      return new Response("ERROR", { status: 500 });
    }

    if (env.HEALTHCHECK_DATABASE_DISABLED === "1") {
      return new Response("OK");
    }

    await prisma.$queryRaw`SELECT 1`;

    return new Response("OK");
  } catch (error: unknown) {
    console.log("healthcheck ❌", { error });
    return new Response("ERROR", { status: 500 });
  }
};
