import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { SetDefaultRegionService } from "~/v3/services/setDefaultRegion.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

const SetDefaultRegionRequestBody = z.object({
  // The worker group name (region name), e.g. "aws-us-east-1".
  region: z.string().min(1),
});

// Clearing the default is unsupported: SetDefaultRegionService has no path to
// unset defaultWorkerGroupId, so only PUT is implemented (other methods 405).
export const action = createActionPATApiRoute(
  {
    method: "PUT",
    params: ParamsSchema,
    body: SetDefaultRegionRequestBody,
    // Resolve the org (id only, no membership) so the plugin can compute the
    // caller's role floor for the manage:project gate below.
    context: async ({ projectRef }) => {
      const project = await prisma.project.findFirst({
        where: { externalRef: projectRef, deletedAt: null },
        select: { organizationId: true },
      });
      return project ? { organizationId: project.organizationId } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "project" }) },
  },
  async ({ params, body, authentication }) => {
    // Membership floor: resolve scoped to the caller so a non-member gets a 404
    // (the authorization block enforces the role; this enforces membership).
    const project = await prisma.project.findFirst({
      where: {
        externalRef: params.projectRef,
        organization: {
          deletedAt: null,
          members: { some: { userId: authentication.userId } },
        },
        deletedAt: null,
      },
      select: { id: true, slug: true },
    });

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    // Resolve the region name to a worker group id the same way the dashboard
    // does — through the presenter, which filters to regions this project can
    // actually use (allowed queues / hidden / compute access). PAT users are
    // never admins here.
    const presenter = new RegionsPresenter();
    const [presenterError, result] = await tryCatch(
      presenter.call({ userId: authentication.userId, projectSlug: project.slug })
    );

    if (presenterError) {
      return json({ error: presenterError.message }, { status: 400 });
    }

    const region = result.regions.find((r) => r.name === body.region);

    if (!region) {
      return json(
        {
          error: `Region '${body.region}' not found`,
          availableRegions: result.regions.map((r) => r.name),
        },
        { status: 400 }
      );
    }

    // SetDefaultRegionService throws ServiceValidationError; the builder maps it
    // to its status (default 400).
    const updated = await new SetDefaultRegionService().call({
      projectId: project.id,
      regionId: region.id,
    });

    return json({ id: updated.id, name: updated.name });
  }
);
