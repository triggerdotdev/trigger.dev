import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { type Project, WorkerInstanceGroupType, WorkloadType } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";

const RequestBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  projectId: z.string().optional(),
  makeDefaultForProject: z.boolean().default(false),
  removeDefaultFromProject: z.boolean().default(false),
  type: z.nativeEnum(WorkerInstanceGroupType).optional(),
  hidden: z.boolean().optional(),
  workloadType: z.nativeEnum(WorkloadType).optional(),
  cloudProvider: z.string().optional(),
  location: z.string().optional(),
  staticIPs: z.string().optional(),
  enableFastPath: z.boolean().optional(),
});

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const workerGroups = await prisma.workerInstanceGroup.findMany({
    orderBy: { createdAt: "asc" },
  });

  return json({ workerGroups });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    const rawBody = await request.json();
    const {
      name,
      description,
      projectId,
      makeDefaultForProject,
      removeDefaultFromProject,
      type,
      hidden,
      workloadType,
      cloudProvider,
      location,
      staticIPs,
      enableFastPath,
    } = RequestBodySchema.parse(rawBody ?? {});

    if (removeDefaultFromProject) {
      if (!projectId) {
        return json(
          {
            error: "projectId is required to remove default worker group from project",
          },
          { status: 400 }
        );
      }

      const updated = await removeDefaultWorkerGroupFromProject(projectId);

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
      const { workerGroup, token } = await createWorkerGroup({
        name,
        description,
        type,
        hidden,
        workloadType,
        cloudProvider,
        location,
        staticIPs,
        enableFastPath,
      });

      if (!makeDefaultForProject) {
        return json({
          outcome: "created new worker group",
          token,
          workerGroup,
        });
      }

      if (!projectId) {
        return json(
          { error: "projectId is required to set worker group as default for project" },
          { status: 400 }
        );
      }

      const updated = await setWorkerGroupAsDefaultForProject(workerGroup.id, projectId);

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

    if (!makeDefaultForProject) {
      return json(
        {
          error: "worker group already exists",
          workerGroup: existingWorkerGroup,
        },
        { status: 400 }
      );
    }

    if (!projectId) {
      return json(
        { error: "projectId is required to set worker group as default for project" },
        { status: 400 }
      );
    }

    const updated = await setWorkerGroupAsDefaultForProject(existingWorkerGroup.id, projectId);

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

async function createWorkerGroup(
  options: Parameters<WorkerGroupService["createWorkerGroup"]>[0]
) {
  const service = new WorkerGroupService();
  return await service.createWorkerGroup(options);
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
