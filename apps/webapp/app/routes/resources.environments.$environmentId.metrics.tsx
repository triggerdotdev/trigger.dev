import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { z } from "zod";
import { MetricsQuery } from "~/api/metric";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { $replica } from "~/db.server";
import { regenerateApiKey } from "~/models/api-key.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { MetricPresenter } from "~/presenters/v3/MetricPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { createSearchParams } from "~/utils/searchParams";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { environmentId } = ParamsSchema.parse(params);

  try {
    const environment = await $replica.runtimeEnvironment.findUnique({
      where: {
        id: environmentId,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      select: {
        organizationId: true,
        projectId: true,
      },
    });

    if (!environment) {
      throw new Response(
        "This environment does not exist or you do not have permission to access it"
      );
    }

    const searchParams = createSearchParams(request.url, MetricsQuery);
    if (!searchParams.success) {
      throw new Response(searchParams.error, { status: 400 });
    }

    const metricPresenter = new MetricPresenter();
    const [error, result] = await tryCatch(
      metricPresenter.call({
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId,
        query: searchParams.params.getAll(),
      })
    );

    if (error) {
      throw new Response(error.message, { status: 500 });
    }

    return json(result);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    if (error instanceof Error) {
      throw new Response(error.message, { status: 500 });
    }

    logger.error("Unknown error", { error: JSON.stringify(error) });
    throw new Response("Unknown error", { status: 500 });
  }
}
