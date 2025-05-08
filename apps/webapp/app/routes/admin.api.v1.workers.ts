import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { type Project } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";

const RequestBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  makeDefaultForProjectId: z.string().optional(),
  removeDefaultFromProject: z.boolean().default(false),
});

export async function action({ request }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findFirst({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (!user.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  try {
    const rawBody = await request.json();
    const { name, description, makeDefaultForProjectId, removeDefaultFromProject } =
      RequestBodySchema.parse(rawBody ?? {});

    if (removeDefaultFromProject) {
      if (!makeDefaultForProjectId) {
        return json(
          {
            error:
              "makeDefaultForProjectId is required to remove default worker group from project",
          },
          { status: 400 }
        );
      }

      const updated = await removeDefaultWorkerGroupFromProject(makeDefaultForProjectId);

      if (!updated.success) {
        return json(
          { error: `failed to remove default worker group from project: ${updated.error}` },
          { status: 400 }
        );
      }

      return json({
        outcome: "removed default worker group from project",
        project: updated.project,
      });
    }

    const existingWorkerGroup = await prisma.workerInstanceGroup.findFirst({
      where: {
        // We only check managed worker groups
        masterQueue: name,
      },
    });

    if (!existingWorkerGroup) {
      const { workerGroup, token } = await createWorkerGroup(name, description);

      if (!makeDefaultForProjectId) {
        return json({
          outcome: "created new worker group",
          token,
          workerGroup,
        });
      }

      const updated = await setWorkerGroupAsDefaultForProject(
        workerGroup.id,
        makeDefaultForProjectId
      );

      if (!updated.success) {
        return json({ error: updated.error }, { status: 400 });
      }

      return json({
        outcome: "set new worker group as default for project",
        token,
        workerGroup,
        project: updated.project,
      });
    }

    if (!makeDefaultForProjectId) {
      return json(
        {
          error: "worker group already exists",
          workerGroup: existingWorkerGroup,
        },
        { status: 400 }
      );
    }

    const updated = await setWorkerGroupAsDefaultForProject(
      existingWorkerGroup.id,
      makeDefaultForProjectId
    );

    if (!updated.success) {
      return json(
        {
          error: `failed to set worker group as default for project: ${updated.error}`,
          workerGroup: existingWorkerGroup,
        },
        { status: 400 }
      );
    }

    return json({
      outcome: "set existing worker group as default for project",
      workerGroup: existingWorkerGroup,
      project: updated.project,
    });
  } catch (error) {
    return json(
      {
        outcome: "unknown error",
        error: error instanceof Error ? error.message : error,
      },
      { status: 400 }
    );
  }
}

async function createWorkerGroup(name: string | undefined, description: string | undefined) {
  const service = new WorkerGroupService();
  return await service.createWorkerGroup({ name, description });
}

async function removeDefaultWorkerGroupFromProject(projectId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
    },
  });

  if (!project) {
    return {
      success: false,
      error: "project not found",
    };
  }

  const [error] = await tryCatch(
    prisma.project.update({
      where: {
        id: projectId,
      },
      data: {
        defaultWorkerGroupId: null,
      },
    })
  );

  if (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : error,
    };
  }

  return {
    success: true,
    project,
  };
}

async function setWorkerGroupAsDefaultForProject(
  workerGroupId: string,
  projectId: string
): Promise<
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      project: Project;
    }
> {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
    },
  });

  if (!project) {
    return {
      success: false,
      error: "project not found",
    };
  }

  const [error] = await tryCatch(
    prisma.project.update({
      where: {
        id: projectId,
      },
      data: {
        defaultWorkerGroupId: workerGroupId,
      },
    })
  );

  if (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : error,
    };
  }

  return {
    success: true,
    project,
  };
}
