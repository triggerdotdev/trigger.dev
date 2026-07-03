import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { SetDefaultRegionService } from "~/v3/services/setDefaultRegion.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

const SetDefaultRegionRequestBody = z.object({
  // The worker group name (region name), e.g. "aws-us-east-1".
  region: z.string().min(1),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Clearing the default is unsupported: SetDefaultRegionService has no path to
  // unset defaultWorkerGroupId, so DELETE is intentionally not implemented.
  if (request.method.toUpperCase() !== "PUT") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const project = await prisma.project.findFirst({
      where: {
        externalRef: parsedParams.data.projectRef,
        organization: {
          deletedAt: null,
          members: { some: { userId: authenticationResult.userId } },
        },
        deletedAt: null,
      },
      select: { id: true, slug: true },
    });

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = SetDefaultRegionRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    // Resolve the region name to a worker group id the same way the dashboard
    // does — through the presenter, which filters to regions this project can
    // actually use (allowed queues / hidden / compute access). PAT users are
    // never admins here.
    const presenter = new RegionsPresenter();
    const [presenterError, result] = await tryCatch(
      presenter.call({ userId: authenticationResult.userId, projectSlug: project.slug })
    );

    if (presenterError) {
      return json({ error: presenterError.message }, { status: 400 });
    }

    const region = result.regions.find((r) => r.name === body.data.region);

    if (!region) {
      return json(
        {
          error: `Region '${body.data.region}' not found`,
          availableRegions: result.regions.map((r) => r.name),
        },
        { status: 400 }
      );
    }

    try {
      const updated = await new SetDefaultRegionService().call({
        projectId: project.id,
        regionId: region.id,
      });

      return json({ id: updated.id, name: updated.name });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to set default region", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
