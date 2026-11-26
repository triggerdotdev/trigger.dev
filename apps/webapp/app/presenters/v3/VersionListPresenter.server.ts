import { versionStanding } from "~/utils/versionLabel";
import { findCurrentVersion } from "~/v3/models/workerDeployment.server";
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

    const currentVersion = await findCurrentVersion(environment, this._replica);

    return {
      success: true as const,
      versions: versions.map((version) => ({
        version: version.version,
        standing: versionStanding(version.version, currentVersion),
      })),
      hasFilters,
    };
  }
}
