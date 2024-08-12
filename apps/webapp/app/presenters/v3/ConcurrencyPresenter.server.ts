import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { Prisma, sqlDatabaseSchema } from "~/db.server";
import { type Project } from "~/models/project.server";
import {
  displayableEnvironment,
  type DisplayableInputEnvironment,
} from "~/models/runtimeEnvironment.server";
import { type User } from "~/models/user.server";
import { getLimit } from "~/services/platform.v3.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";
import { BasePresenter } from "./basePresenter.server";

export type Environment = Awaited<
  ReturnType<ConcurrencyPresenter["environmentConcurrency"]>
>[number];

export class ConcurrencyPresenter extends BasePresenter {
  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const project = await this._replica.project.findFirst({
      select: {
        id: true,
        organizationId: true,
        environments: {
          select: {
            id: true,
            apiKey: true,
            pkApiKey: true,
            type: true,
            slug: true,
            updatedAt: true,
            orgMember: {
              select: {
                user: { select: { id: true, name: true, displayName: true } },
              },
            },
            maximumConcurrencyLimit: true,
          },
        },
      },
      where: {
        slug: projectSlug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    return {
      environments: this.environmentConcurrency(project.id, userId, project.environments),
    };
  }

  async environmentConcurrency(
    projectId: string,
    userId: string,
    environments: (DisplayableInputEnvironment & { maximumConcurrencyLimit: number })[]
  ) {
    const environmentConcurrency = await concurrencyTracker.environmentConcurrentRunCounts(
      projectId,
      environments.map((env) => env.id)
    );

    const queued = await this._replica.$queryRaw<
      {
        runtimeEnvironmentId: string;
        count: BigInt;
      }[]
    >`
SELECT
    "runtimeEnvironmentId",
    COUNT(*)
FROM
    ${sqlDatabaseSchema}."TaskRun" as tr
WHERE
    tr."projectId" = ${projectId}
    AND tr."status" = ANY(ARRAY[${Prisma.join(QUEUED_STATUSES)}]::\"TaskRunStatus\"[])
GROUP BY
    tr."runtimeEnvironmentId";`;

    const sortedEnvironments = sortEnvironments(environments).map((environment) => ({
      ...displayableEnvironment(environment, userId),
      concurrencyLimit: environment.maximumConcurrencyLimit,
      concurrency: environmentConcurrency[environment.id] ?? 0,
      queued: Number(queued.find((q) => q.runtimeEnvironmentId === environment.id)?.count ?? 0),
    }));

    return sortedEnvironments;
  }
}
