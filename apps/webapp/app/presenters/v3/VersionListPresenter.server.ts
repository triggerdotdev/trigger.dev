import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { type RuntimeEnvironment } from "@trigger.dev/database";
import { BasePresenter } from "./basePresenter.server";

const DEFAULT_ITEMS_PER_PAGE = 25;
const MAX_ITEMS_PER_PAGE = 100;

export class VersionListPresenter extends BasePresenter {
  private readonly perPage: number;

  constructor(perPage: number = DEFAULT_ITEMS_PER_PAGE) {
    super();
    this.perPage = Math.min(perPage, MAX_ITEMS_PER_PAGE);
  }

  public async call({
    environment,
    query,
  }: {
    environment: Pick<RuntimeEnvironment, "id" | "type">;
    query?: string;
  }) {
    const hasFilters = query !== undefined && query.length > 0;

    const versions = await this._replica.backgroundWorker.findMany({
      select: {
        version: true,
      },
      where: {
        runtimeEnvironmentId: environment.id,
        version: query
          ? {
              contains: query,
            }
          : undefined,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: this.perPage,
    });

    let currentVersion: string | undefined;

    if (environment.type !== "DEVELOPMENT") {
      const currentWorker = await this._replica.workerDeploymentPromotion.findFirst({
        select: {
          deployment: {
            select: {
              version: true,
            },
          },
        },
        where: {
          environmentId: environment.id,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
      });

      if (currentWorker) {
        currentVersion = currentWorker.deployment.version;
      }
    }

    return {
      success: true as const,
      versions: versions.map((version) => ({
        version: version.version,
        isCurrent: version.version === currentVersion,
      })),
      hasFilters,
    };
  }
}
