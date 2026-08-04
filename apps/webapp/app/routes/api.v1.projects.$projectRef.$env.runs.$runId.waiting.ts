import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  readQueueSignals,
  findWaitingRun,
} from "~/presenters/v3/waitingRun/waitingRunDiagnosis.server";
import {
  computeWaitingRunDiagnosis,
  type WaitingRunRow,
} from "~/presenters/v3/waitingRun/waitingRunDiagnosis";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

/**
 * GET /api/v1/projects/:projectRef/:env/runs/:runId/waiting
 *
 * Thin adapter: authorize here, then hand off to the deterministic waiting-run diagnosis
 * (no LLM, transport-independent) so the same capability can back MCP later.
 */

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
  runId: z.string(), // the run's friendly id
});

type Params = z.infer<typeof ParamsSchema>;

/**
 * The bearer token already pins the environment, so the path segments are a consistency check,
 * not a lookup. A mismatch is treated as "not here" (404) rather than 400, so a token for one
 * environment can't probe another environment's paths.
 */
function environmentMatchesParams(environment: AuthenticatedEnvironment, params: Params): boolean {
  if (environment.project.externalRef !== params.projectRef) return false;
  // The staging slug is stored as "stg"; preview environments are branch-scoped children.
  if (params.env === "preview") return environment.type === "PREVIEW";
  const expectedSlug = params.env === "staging" ? "stg" : params.env;
  return environment.slug === expectedSlug;
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    // Called with the environment JWT the dashboard agent mints (read:runs).
    allowJWT: true,
    findResource: async (params, auth): Promise<WaitingRunRow | undefined> => {
      if (!environmentMatchesParams(auth.environment, params)) return undefined;
      // Runs in other environments are invisible: the point-read is scoped to this env.
      return (await findWaitingRun(params.runId, auth.environment.id)) ?? undefined;
    },
    authorization: {
      action: "read",
      resource: (run) => anyResource([{ type: "runs", id: run.friendlyId }]),
    },
  },
  async ({ resource: run, authentication }) => {
    const environment = authentication.environment;
    const now = new Date();

    try {
      const diagnosis = await computeWaitingRunDiagnosis(
        {
          // Already read by findResource — don't pay for the point-read twice.
          readRun: async () => run,
          readQueueSignals: (queueName) => readQueueSignals(environment, queueName, now),
        },
        { now }
      );

      if (!diagnosis) {
        return json({ error: "Not found" }, { status: 404 });
      }

      return json(diagnosis, { status: 200 });
    } catch (error) {
      // The builder answers a thrown Response with that response; swallowing one
      // here would turn it into a 500.
      if (error instanceof Response) throw error;
      logger.error("Failed to diagnose waiting run", {
        error,
        runId: run.friendlyId,
        environmentId: environment.id,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
      });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);
