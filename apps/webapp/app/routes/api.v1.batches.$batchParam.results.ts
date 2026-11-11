import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { runOpsLegacyReplica, runOpsNewReplica, runOpsSplitReadEnabled } from "~/db.server";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { unroutableIdResponse } from "~/services/routeBuilders/unroutableId.server";

const ParamsSchema = z.object({
  /* This is the batch friendly ID */
  batchParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    // Authenticate the request
    const authResult = await authenticateApiKeyWithScope(request, {
      action: "read",
      resource: { type: "batch", id: params.batchParam },
      allowRunToken: true,
    });
    if (!authResult.ok) {
      return json({ error: authResult.error }, { status: authResult.status });
    }
    const authenticationResult = authResult.authentication;

    const parsed = ParamsSchema.safeParse(params);

    if (!parsed.success) {
      return json({ error: "Invalid or missing run ID" }, { status: 400 });
    }

    const { batchParam } = parsed.data;

    try {
      const presenter = new ApiBatchResultsPresenter(undefined, undefined, {
        newClient: runOpsNewReplica,
        legacyReplica: runOpsLegacyReplica,
        splitEnabled: runOpsSplitReadEnabled,
      });
      const result = await presenter.call(batchParam, authenticationResult.environment);

      if (!result) {
        return json({ error: "Batch not found" }, { status: 404 });
      }

      return json(result);
    } catch (error) {
      const unroutable = unroutableIdResponse(error);
      if (unroutable) {
        logger.warn("Unroutable batch id on batch results", {
          error: error instanceof Error ? error.message : error,
          environmentId: authenticationResult.environment.id,
        });
        return unroutable;
      }

      logger.error("Failed to load batch results", {
        error,
        environmentId: authenticationResult.environment.id,
      });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load batch results (outer)", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
