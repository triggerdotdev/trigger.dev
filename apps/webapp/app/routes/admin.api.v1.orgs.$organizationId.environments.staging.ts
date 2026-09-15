import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  Prisma,
  type RuntimeEnvironment,
  type Organization,
  type Project,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createEnvironment } from "~/models/organization.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

/**
 * It will create a staging environment for all the projects where there isn't one already
 */
export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findUnique({
    where: {
      id: organizationId,
    },
    include: {
      projects: {
        include: { environments: true },
      },
    },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  let created = 0;

  for (const project of organization.projects) {
    const stagingResult = await upsertEnvironment(organization, project, "STAGING", false);
    if (stagingResult.status === "created") {
      created++;
    }

    const previewResult = await upsertEnvironment(organization, project, "PREVIEW", true);
    if (previewResult.status === "created") {
      created++;
    }
  }

  return json({ success: true, created, total: organization.projects.length });
}

async function upsertEnvironment(
  organization: Organization,
  project: Project & { environments: RuntimeEnvironment[] },
  type: RuntimeEnvironmentType,
  isBranchableEnvironment: boolean
) {
  const existingEnvironment = project.environments.find(
    (env) => env.type === type && env.parentEnvironmentId === null
  );

  if (existingEnvironment) {
    await updateEnvConcurrencyLimits({ ...existingEnvironment, organization, project });
    return { status: "updated", environment: existingEnvironment };
  }

  try {
    const newEnvironment = await createEnvironment({
      organization,
      project,
      type,
      isBranchableEnvironment,
    });
    await updateEnvConcurrencyLimits({ ...newEnvironment, organization, project });
    return { status: "created", environment: newEnvironment };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existingAfterConflict = await prisma.runtimeEnvironment.findFirst({
        where: {
          organizationId: organization.id,
          projectId: project.id,
          type,
          parentEnvironmentId: null,
        },
      });

      if (existingAfterConflict) {
        await updateEnvConcurrencyLimits({ ...existingAfterConflict, organization, project });
        return { status: "updated", environment: existingAfterConflict };
      }
    }

    throw error;
  }
}
