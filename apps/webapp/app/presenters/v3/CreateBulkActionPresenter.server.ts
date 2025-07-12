import { type PrismaClient } from "@trigger.dev/database";
import { CreateBulkActionSearchParams } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.bulkaction";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { RunsRepository } from "~/services/runsRepository.server";
import { getRunFiltersFromRequest } from "../RunFilters.server";
import { BasePresenter } from "./basePresenter.server";

type CreateBulkActionOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  request: Request;
};

export class CreateBulkActionPresenter extends BasePresenter {
  public async call({
    organizationId,
    projectId,
    environmentId,
    request,
  }: CreateBulkActionOptions) {
    const filters = await getRunFiltersFromRequest(request);
    const { mode, action } = CreateBulkActionSearchParams.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );

    if (!clickhouseClient) {
      throw new Error("Clickhouse client not found");
    }

    const runsRepository = new RunsRepository({
      clickhouse: clickhouseClient,
      prisma: this._replica as PrismaClient,
    });

    const count = await runsRepository.countRuns({
      organizationId,
      projectId,
      environmentId,
      ...filters,
    });

    return {
      filters,
      mode,
      action,
      count,
    };
  }
}
