import { type Project } from "~/models/project.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { type User } from "~/models/user.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";
import { BasePresenter } from "./basePresenter.server";

export class ConcurrencyPresenter extends BasePresenter {
  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const project = await this._replica.project.findFirst({
      select: {
        id: true,
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

    //get all possible tasks
    const possibleTasks = await getAllTaskIdentifiers(this._replica, project.id);
    const concurrencies = await concurrencyTracker.taskConcurrentRunCounts(
      project.id,
      possibleTasks.map((task) => task.slug)
    );

    const environmentConcurrency = await concurrencyTracker.environmentConcurrentRunCounts(
      project.id,
      project.environments.map((env) => env.id)
    );

    const sortedEnvironments = sortEnvironments(project.environments).map((environment) => ({
      ...displayableEnvironment(environment, userId),
      concurrencyLimit: environment.maximumConcurrencyLimit,
      concurrency: environmentConcurrency[environment.id] ?? 0,
    }));

    return {
      environments: sortedEnvironments,
      tasks: possibleTasks
        .map((task) => ({
          identifier: task.slug,
          triggerSource: task.triggerSource,
          concurrency: concurrencies[task.slug] ?? 0,
        }))
        .sort((a, b) => a.identifier.localeCompare(b.identifier)),
    };
  }
}
