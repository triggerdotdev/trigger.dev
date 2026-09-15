import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  RegionNotAllowedForTaskError,
  WorkerGroupService,
} from "../app/v3/services/worker/workerGroupService.server.js";

vi.setConfig({ testTimeout: 60_000 });

async function seed(prisma: PrismaClient) {
  const suffix = Math.random().toString(36).slice(2, 10);

  const organization = await prisma.organization.create({
    data: { title: `org_${suffix}`, slug: `org_${suffix}` },
  });

  const managedGroup = (name: string, hidden = false) =>
    prisma.workerInstanceGroup.create({
      data: {
        name,
        masterQueue: name,
        type: "MANAGED",
        hidden,
        token: { create: { tokenHash: `${name}_${suffix}` } },
      },
    });

  const usEast = await managedGroup("us-east-1");
  const euCentral = await managedGroup("eu-central-1");
  const hidden = await managedGroup("hidden-1", true);

  const project = await prisma.project.create({
    data: {
      name: `project_${suffix}`,
      slug: `project_${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
      defaultWorkerGroupId: usEast.id,
    },
  });

  const otherProject = await prisma.project.create({
    data: {
      name: `other_${suffix}`,
      slug: `other_${suffix}`,
      externalRef: `proj_other_${suffix}`,
      organizationId: organization.id,
    },
  });

  const otherProjectGroup = await prisma.workerInstanceGroup.create({
    data: {
      name: "private-1",
      masterQueue: `${otherProject.id}-private-1`,
      type: "UNMANAGED",
      project: { connect: { id: otherProject.id } },
      organization: { connect: { id: organization.id } },
      token: { create: { tokenHash: `private_${suffix}` } },
    },
  });

  return { project, usEast, euCentral, hidden, otherProjectGroup };
}

describe("WorkerGroupService.getDefaultWorkerGroupForProject with a task region allowlist", () => {
  postgresTest("resolves a per-trigger override that is inside the list", async ({ prisma }) => {
    const { project, euCentral } = await seed(prisma);
    const service = new WorkerGroupService({ prisma });

    const group = await service.getDefaultWorkerGroupForProject({
      projectId: project.id,
      regionOverride: "eu-central-1",
      allowedRegions: ["eu-central-1", "us-east-1"],
      taskId: "my-task",
    });

    expect(group?.id).toBe(euCentral.id);
  });

  postgresTest(
    "rejects a per-trigger override outside the list, naming the task and the list",
    async ({ prisma }) => {
      const { project } = await seed(prisma);
      const service = new WorkerGroupService({ prisma });

      const attempt = service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        regionOverride: "us-east-1",
        allowedRegions: ["eu-central-1"],
        taskId: "my-task",
      });

      await expect(attempt).rejects.toBeInstanceOf(RegionNotAllowedForTaskError);
      await expect(attempt).rejects.toThrow(
        'Task "my-task" can only run in: eu-central-1. You specified "us-east-1".'
      );
    }
  );

  postgresTest("prefers the project default when the task allows it", async ({ prisma }) => {
    const { project, usEast } = await seed(prisma);
    const service = new WorkerGroupService({ prisma });

    const group = await service.getDefaultWorkerGroupForProject({
      projectId: project.id,
      allowedRegions: ["eu-central-1", "us-east-1"],
      taskId: "my-task",
    });

    expect(group?.id).toBe(usEast.id);
  });

  postgresTest(
    "falls back to the first listed region when the project default is not allowed",
    async ({ prisma }) => {
      const { project, euCentral } = await seed(prisma);
      const service = new WorkerGroupService({ prisma });

      const group = await service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        allowedRegions: ["eu-central-1", "hidden-1"],
        taskId: "my-task",
      });

      expect(group?.id).toBe(euCentral.id);
    }
  );

  postgresTest("requires the first listed region to exist", async ({ prisma }) => {
    const { project } = await seed(prisma);
    const service = new WorkerGroupService({ prisma });

    await expect(
      service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        allowedRegions: ["nope"],
        taskId: "my-task",
      })
    ).rejects.toThrow('The region configured on task "my-task" doesn\'t exist ("nope").');
  });

  postgresTest("applies the usual access checks to the first listed region", async ({ prisma }) => {
    const { project, otherProjectGroup } = await seed(prisma);
    const service = new WorkerGroupService({ prisma });

    // Hidden group.
    await expect(
      service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        allowedRegions: ["hidden-1"],
        taskId: "my-task",
      })
    ).rejects.toThrow(
      'The region configured on task "my-task" isn\'t available to you ("hidden-1").'
    );

    // Another project's UNMANAGED group.
    await expect(
      service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        allowedRegions: [otherProjectGroup.masterQueue],
        taskId: "my-task",
      })
    ).rejects.toThrow(
      `The region configured on task "my-task" isn't available to you ("${otherProjectGroup.masterQueue}").`
    );

    // Project restricted to specific queues.
    await prisma.project.update({
      where: { id: project.id },
      data: { allowedWorkerQueues: ["us-east-1"] },
    });

    await expect(
      service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        allowedRegions: ["eu-central-1"],
        taskId: "my-task",
      })
    ).rejects.toThrow(
      'You don\'t have access to this region ("eu-central-1"). You can use the following regions: us-east-1.'
    );
  });

  postgresTest(
    "keeps the existing behaviour when the task has no allowlist",
    async ({ prisma }) => {
      const { project, usEast, euCentral } = await seed(prisma);
      const service = new WorkerGroupService({ prisma });

      const byDefault = await service.getDefaultWorkerGroupForProject({ projectId: project.id });
      expect(byDefault?.id).toBe(usEast.id);

      const emptyList = await service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        allowedRegions: [],
      });
      expect(emptyList?.id).toBe(usEast.id);

      const overridden = await service.getDefaultWorkerGroupForProject({
        projectId: project.id,
        regionOverride: "eu-central-1",
      });
      expect(overridden?.id).toBe(euCentral.id);

      await expect(
        service.getDefaultWorkerGroupForProject({ projectId: project.id, regionOverride: "nope" })
      ).rejects.toThrow('The region you specified doesn\'t exist ("nope").');
    }
  );
});
