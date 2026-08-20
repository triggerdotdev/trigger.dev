import { json } from "@remix-run/server-runtime";
import type { GetProjectRuntimesResponseBody } from "@trigger.dev/core/v3";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { listCurrentProductionProjectRuntimes } from "~/services/projectRuntimeUpdates.server";

// Identity-only: like /api/v1/projects, this returns resources across every organization the PAT
// owner belongs to. Runtime details are limited to each project's current Production deployment.
export const loader = createLoaderPATApiRoute(
  { identityOnly: true },
  async ({ authentication }) => {
    const runtimes: GetProjectRuntimesResponseBody = await listCurrentProductionProjectRuntimes({
      userId: authentication.userId,
    });

    return json(runtimes);
  }
);
