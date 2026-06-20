import { type ErrorGroupListItem } from "@trigger.dev/core/v3";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { type ErrorGroupStatus, type Project, type RuntimeEnvironment } from "@trigger.dev/database";
import { z } from "zod";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { CoercedDate } from "~/utils/zod";
import {
  ErrorsListPresenter,
  type ErrorsListOptions,
} from "./ErrorsListPresenter.server";
import { BasePresenter } from "./basePresenter.server";

// API status (lowercase) <-> DB ErrorGroupState.status (uppercase).
const API_STATUS_TO_DB: Record<string, ErrorGroupStatus> = {
  unresolved: "UNRESOLVED",
  resolved: "RESOLVED",
  ignored: "IGNORED",
};

const DB_STATUS_TO_API: Record<ErrorGroupStatus, ErrorGroupListItem["status"]> = {
  UNRESOLVED: "unresolved",
  RESOLVED: "resolved",
  IGNORED: "ignored",
};

export const ApiErrorListSearchParams = z.object({
  "page[size]": z.coerce.number().int().positive().min(1).max(100).optional(),
  "page[after]": z.string().optional(),
  "page[before]": z.string().optional(),
  "filter[taskIdentifier]": z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  "filter[version]": z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  "filter[status]": z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) {
        return undefined;
      }

      const statuses = value.split(",");
      const invalid = statuses.filter((status) => !(status in API_STATUS_TO_DB));

      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid status values: ${invalid.join(
            ", "
          )}. Allowed: unresolved, resolved, ignored.`,
        });
        return z.NEVER;
      }

      return Array.from(new Set(statuses.map((status) => API_STATUS_TO_DB[status])));
    }),
  "filter[search]": z.string().max(1000).optional(),
  "filter[period]": z.string().optional(),
  "filter[from]": CoercedDate,
  "filter[to]": CoercedDate,
});

type ApiErrorListSearchParams = z.infer<typeof ApiErrorListSearchParams>;

export class ApiErrorListPresenter extends BasePresenter {
  public async call(
    project: Pick<Project, "id" | "organizationId">,
    environment: Pick<RuntimeEnvironment, "id" | "organizationId">,
    searchParams: ApiErrorListSearchParams
  ): Promise<{
    data: ErrorGroupListItem[];
    pagination: { next?: string; previous?: string };
  }> {
    return this.trace("call", async () => {
      const options: ErrorsListOptions = {
        projectId: project.id,
        defaultPeriod: "1d",
      };

      if (searchParams["page[size]"]) {
        options.pageSize = searchParams["page[size]"];
      }

      if (searchParams["page[after]"]) {
        options.cursor = searchParams["page[after]"];
        options.direction = "forward";
      }

      if (searchParams["page[before]"]) {
        options.cursor = searchParams["page[before]"];
        options.direction = "backward";
      }

      if (searchParams["filter[taskIdentifier]"]) {
        options.tasks = searchParams["filter[taskIdentifier]"];
      }

      if (searchParams["filter[version]"]) {
        options.versions = searchParams["filter[version]"];
      }

      if (searchParams["filter[status]"]) {
        options.statuses = searchParams["filter[status]"];
      }

      if (searchParams["filter[search]"]) {
        options.search = searchParams["filter[search]"];
      }

      if (searchParams["filter[period]"]) {
        options.period = searchParams["filter[period]"];
      }

      if (searchParams["filter[from]"]) {
        options.from = searchParams["filter[from]"].getTime();
      }

      if (searchParams["filter[to]"]) {
        options.to = searchParams["filter[to]"].getTime();
      }

      const organizationId = environment.organizationId;

      const plan = await getCurrentPlan(organizationId);
      options.retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

      // The errors data lives in the "logs" ClickHouse client, matching the
      // dashboard list loader.
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        organizationId,
        "logs"
      );

      const presenter = new ErrorsListPresenter(this._replica, clickhouse);
      const result = await presenter.call(organizationId, environment.id, options);

      return {
        data: result.errorGroups.map((group) => ({
          id: ErrorId.toFriendlyId(group.fingerprint),
          fingerprint: group.fingerprint,
          taskIdentifier: group.taskIdentifier,
          errorType: group.errorType,
          errorMessage: group.errorMessage,
          status: DB_STATUS_TO_API[group.status],
          count: group.count,
          firstSeen: group.firstSeen,
          lastSeen: group.lastSeen,
          resolvedAt: group.resolvedAt,
          ignoredUntil: group.ignoredUntil,
        })),
        pagination: result.pagination,
      };
    });
  }
}
