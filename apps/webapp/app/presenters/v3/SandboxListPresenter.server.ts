import {
  type PrismaClientOrTransaction,
  type SandboxEnvironment,
  type SandboxStatus,
  type SandboxType,
} from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

export type SandboxListItem = {
  id: string;
  friendlyId: string;
  deduplicationKey: string;
  type: SandboxType;
  status: SandboxStatus;
  runtime: string;
  packages: string[];
  systemPackages: string[];
  imageReference: string | null;
  imageVersion: string | null;
  contentHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  taskCount: number;
  taskSlugs: string[];
  tasks: Array<{
    slug: string;
    filePath: string;
  }>;
};

export class SandboxListPresenter {
  constructor(private readonly _replica: PrismaClientOrTransaction) {}

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    environmentSlug,
  }: {
    userId: string;
    organizationSlug: string;
    projectSlug: string;
    environmentSlug: string;
  }): Promise<{
    sandboxes: SandboxListItem[];
  }> {
    const environment = await this._replica.runtimeEnvironment.findFirstOrThrow({
      where: {
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
        project: {
          slug: projectSlug,
        },
        slug: environmentSlug,
      },
      include: {
        organization: true,
        project: true,
      },
    });

    const currentWorker = await findCurrentWorkerFromEnvironment(
      {
        id: environment.id,
        type: environment.type,
      },
      this._replica
    );

    if (!currentWorker) {
      return {
        sandboxes: [],
      };
    }

    // Find all sandbox tasks for the current worker
    const sandboxTasks = await this._replica.backgroundWorkerTask.findMany({
      where: {
        workerId: currentWorker.id,
        triggerSource: "SANDBOX",
        sandboxEnvironmentId: {
          not: null,
        },
      },
      select: {
        id: true,
        slug: true,
        filePath: true,
        sandboxEnvironmentId: true,
        sandboxEnvironment: true,
      },
    });

    // Group tasks by sandbox environment
    const sandboxMap = new Map<
      string,
      SandboxEnvironment & {
        taskSlugs: string[];
        tasks: Array<{ slug: string; filePath: string }>;
      }
    >();

    for (const task of sandboxTasks) {
      if (!task.sandboxEnvironment) continue;

      const existing = sandboxMap.get(task.sandboxEnvironment.id);
      if (existing) {
        existing.taskSlugs.push(task.slug);
        existing.tasks.push({ slug: task.slug, filePath: task.filePath });
      } else {
        sandboxMap.set(task.sandboxEnvironment.id, {
          ...task.sandboxEnvironment,
          taskSlugs: [task.slug],
          tasks: [{ slug: task.slug, filePath: task.filePath }],
        });
      }
    }

    // Convert to list items
    const sandboxes: SandboxListItem[] = Array.from(sandboxMap.values()).map((sandbox) => ({
      id: sandbox.id,
      friendlyId: sandbox.friendlyId,
      deduplicationKey: sandbox.deduplicationKey,
      type: sandbox.type,
      status: sandbox.status,
      runtime: sandbox.runtime,
      packages: sandbox.packages,
      systemPackages: sandbox.systemPackages,
      imageReference: sandbox.imageReference,
      imageVersion: sandbox.imageVersion,
      contentHash: sandbox.contentHash,
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
      taskCount: sandbox.taskSlugs.length,
      taskSlugs: sandbox.taskSlugs,
      tasks: sandbox.tasks,
    }));

    // Sort by createdAt descending
    sandboxes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      sandboxes,
    };
  }
}
