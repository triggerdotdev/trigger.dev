import { type MetricsQuery } from "~/api/metric";
import { BasePresenter } from "./basePresenter.server";

export class MetricPresenter extends BasePresenter {
  public async call({
    organizationId,
    projectId,
    environmentId,
    query,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    query: MetricsQuery;
  }) {
    return {
      metrics: [],
    };
  }
}
