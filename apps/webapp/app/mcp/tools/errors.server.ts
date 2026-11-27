import { parseDate } from "@trigger.dev/core/v3/isomorphic";
import type { z } from "zod";
import { $replica } from "~/db.server";
import {
  ApiErrorListPresenter,
  type ApiErrorListSearchParams,
} from "~/presenters/v3/ApiErrorListPresenter.server";
import { ErrorGroupPresenter } from "~/presenters/v3/ErrorGroupPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { v3ErrorPath } from "~/utils/pathBuilder";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import type { McpToolDefinition } from "../registry.server";
import { dashboardUrl, defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import { chooseErrorTask, fingerprintOf } from "./errorTask.server";
import { errorNotFound, formatErrorDetail, formatErrorList, appliedPeriod } from "./format/errors";
import { plainError } from "./format/insights";
import { untrusted } from "./format/logFields";
import { startReadBudget } from "./readBudget.server";
import { GetErrorDetailsInput, ListErrorsInput } from "./schemas/errors";

const READ_BUDGET_MS = 20_000;
const TOO_SLOW = "Reading errors took too long. Narrow the time range or filters and try again.";
const CANCELLED = "The request was cancelled before the errors were read.";
const SERVICE_ERROR_CHARS = 2_000;

const STATUS_TO_DB = {
  unresolved: "UNRESOLVED",
  resolved: "RESOLVED",
  ignored: "IGNORED",
} as const;

const stopped = (read: { reason: "aborted" | "timeout" }) =>
  plainError(read.reason === "aborted" ? CANCELLED : TOO_SLOW);

function parseTime(value: string | undefined): Date | undefined | null {
  if (value === undefined) return undefined;
  return parseDate(value) ?? null;
}

const serviceError = (error: unknown) => {
  if (error instanceof ServiceValidationError) {
    return plainError(untrusted(error.message, "error-service", SERVICE_ERROR_CHARS));
  }
  throw error;
};

export function createErrorsTools({
  budgetMs = READ_BUDGET_MS,
}: { budgetMs?: number } = {}): McpToolDefinition[] {
  const listErrors = defineReadTool({
    name: "list_errors",
    title: "List Errors",
    description:
      "List an environment's error groups, most occurrences first, like the Errors page in the dashboard. Filter by status, task, version, text and time period (default the last 1d); occurrence counts are for that period. Returns cursors for the next and previous pages. Use get_error_details with a returned error id for one group.",
    shape: ListErrorsInput.shape,
    auth: { action: "read", subject: "errors" },
    run: async (input, ctx) => {
      if (input.after && input.before) {
        return plainError("Invalid arguments: pass either after or before, not both");
      }
      const from = parseTime(input.from);
      if (from === null) return plainError("Invalid arguments: from is not a valid date");
      const to = parseTime(input.to);
      if (to === null) return plainError("Invalid arguments: to is not a valid date");

      const budget = startReadBudget(budgetMs, ctx.signal);
      const found = await budget.read(() => resolveToolEnvironment(ctx));
      if (!found.ok) return stopped(found);
      const environment = found.value;
      if (!environment) return plainError("Environment not found");

      const searchParams: z.output<typeof ApiErrorListSearchParams> = {
        "page[size]": input.limit,
        "page[after]": input.after,
        "page[before]": input.before,
        "filter[taskIdentifier]": input.tasks?.length ? input.tasks : undefined,
        "filter[version]": input.versions?.length ? input.versions : undefined,
        "filter[status]": input.status?.length
          ? [...new Set(input.status.map((s) => STATUS_TO_DB[s]))]
          : undefined,
        "filter[search]": input.search || undefined,
        "filter[period]": input.period,
        "filter[from]": from,
        "filter[to]": to,
      };

      try {
        const page = await budget.read(() =>
          new ApiErrorListPresenter().callWithWindow(environment.project, environment, searchParams)
        );
        if (!page.ok) return stopped(page);
        return textResult(formatErrorList(page.value, appliedPeriod(input)));
      } catch (error) {
        return serviceError(error);
      }
    },
  });

  const getErrorDetails = defineReadTool({
    name: "get_error_details",
    title: "Get Error Details",
    description:
      "Get one error group like its page in the dashboard: type, message, task, status with its resolve or ignore details, total occurrences, first and last seen, the affected versions, and recent runs that failed with it (default the last 7d).",
    shape: GetErrorDetailsInput.shape,
    auth: {
      action: "read",
      subject: "errors",
      resourceId: (args: { errorId?: string }) => args.errorId,
    },
    run: async (input, ctx) => {
      const budget = startReadBudget(budgetMs, ctx.signal);
      const found = await budget.read(() => resolveToolEnvironment(ctx));
      if (!found.ok) return stopped(found);
      const environment = found.value;
      if (!environment) return plainError("Environment not found");

      const fingerprint = fingerprintOf(input.errorId);
      const choice = await budget.read(() =>
        chooseErrorTask(
          {
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            environmentId: environment.id,
          },
          input.errorId,
          input.taskIdentifier,
          budget.limit()
        )
      );
      if (!choice.ok) return stopped(choice);
      if ("notFound" in choice.value) return plainError(errorNotFound(input.errorId));
      if ("ambiguous" in choice.value) return plainError(`${choice.value.ambiguous}.`);
      const task = choice.value.task;
      const stores = await budget.read(() =>
        Promise.all([
          clickhouseFactory.getClickhouseForOrganization(environment.organizationId, "logs"),
          clickhouseFactory.getClickhouseForOrganization(environment.organizationId, "standard"),
          clickhouseFactory.getClickhouseForOrganization(environment.organizationId, "runsList"),
        ])
      );
      if (!stores.ok) return stopped(stores);
      const presenter = new ErrorGroupPresenter($replica, ...stores.value);

      try {
        const result = await budget.read(() =>
          presenter.call(environment.organizationId, environment.id, {
            userId: ctx.identity.userId,
            projectId: environment.projectId,
            fingerprint,
            taskIdentifier: task,
            versions: input.versions?.length ? input.versions : undefined,
            period: input.period,
            cursor: input.runsCursor,
            direction: input.runsCursor ? "forward" : undefined,
            runsPageSize: input.runsLimit,
          })
        );
        if (!result.ok) return stopped(result);
        if (!result.value.errorGroup) return plainError(errorNotFound(input.errorId));

        const url = dashboardUrl(
          v3ErrorPath(environment.organization, environment.project, environment, { fingerprint })
        );
        const { errorGroup, runList, filters } = result.value;
        return textResult(formatErrorDetail(errorGroup, runList, filters, url));
      } catch (error) {
        return serviceError(error);
      }
    },
  });

  return [listErrors, getErrorDetails];
}

export const errorsTools: McpToolDefinition[] = createErrorsTools();
