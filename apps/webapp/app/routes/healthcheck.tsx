import { prisma } from "~/db.server";
import type { LoaderFunction } from "@remix-run/node";
import { env } from "~/env.server";
import { rbac } from "~/services/rbac.server";

export const loader: LoaderFunction = async ({ request }) => {
  try {
    if (env.HEALTHCHECK_DATABASE_DISABLED === "1") {
      return new Response("OK");
    }

    await prisma.$queryRaw`SELECT 1`;

    // Resolve the lazy plugin controller so plugin-load failures surface
    // during readiness probes. With REQUIRE_PLUGINS=1, a failed plugin
    // load throws here and the rollout's readiness probe fails. Without
    // REQUIRE_PLUGINS, the fallback resolves cleanly and this is a noop.
    await rbac.isUsingPlugin();

    return new Response("OK");
  } catch (error: unknown) {
    console.log("healthcheck ❌", { error });
    return new Response("ERROR", { status: 500 });
  }
};
