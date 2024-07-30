import { ListRunResponse, ListRunResponseItem, RunStatus } from "@trigger.dev/core/v3";
import { Project, RuntimeEnvironment, TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { logger } from "~/services/logger.server";
import { ApiRetrieveRunPresenter } from "./ApiRetrieveRunPresenter.server";
import { RunListOptions, RunListPresenter } from "./RunListPresenter.server";
import { BasePresenter } from "./basePresenter.server";

const SearchParamsSchema = z.object({
  "page[size]": z.coerce.number().int().positive().min(1).max(100).optional(),
  "page[after]": z.string().optional(),
  "page[before]": z.string().optional(),
  "filter[status]": z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) {
        return undefined;
      }

      const statuses = value.split(",");
      const parsedStatuses = statuses.map((status) => RunStatus.safeParse(status));

      if (parsedStatuses.some((result) => !result.success)) {
        const invalidStatuses: string[] = [];

        for (const [index, result] of parsedStatuses.entries()) {
          if (!result.success) {
            invalidStatuses.push(statuses[index]);
          }
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid status values: ${invalidStatuses.join(", ")}`,
        });

        return z.NEVER;
      }

      const $statuses = parsedStatuses
        .map((result) => (result.success ? result.data : undefined))
        .filter(Boolean);

      return Array.from(new Set($statuses));
    }),
  "filter[env]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
  "filter[taskIdentifier]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
  "filter[version]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
  "filter[tag]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
  "filter[bulkAction]": z.string().optional(),
  "filter[schedule]": z.string().optional(),
  "filter[isTest]": z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) {
        return undefined;
      }

      if (value === "true") {
        return true;
      }

      if (value === "false") {
        return false;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid value for isTest: ${value}`,
      });

      return z.NEVER;
    }),
  "filter[createdAt][from]": z.coerce.date().optional(),
  "filter[createdAt][to]": z.coerce.date().optional(),
  "filter[createdAt][period]": z.string().optional(),
});

type SearchParamsSchema = z.infer<typeof SearchParamsSchema>;

export class ApiRunListPresenter extends BasePresenter {
  public async call(
    project: Project,
    searchParams: URLSearchParams,
    environment?: RuntimeEnvironment
  ): Promise<ListRunResponse> {
    return this.trace("call", async (span) => {
      const rawSearchParams = Object.fromEntries(searchParams.entries());
      const $searchParams = SearchParamsSchema.safeParse(rawSearchParams);

      if (!$searchParams.success) {
        logger.error("Invalid search params", {
          searchParams: rawSearchParams,
          errors: $searchParams.error.errors,
        });

        throw fromZodError($searchParams.error);
      }

      logger.debug("Valid search params", { searchParams: $searchParams.data });

      const options: RunListOptions = {
        projectId: project.id,
      };

      // pagination
      if ($searchParams.data["page[size]"]) {
        options.pageSize = $searchParams.data["page[size]"];
      }

      if ($searchParams.data["page[after]"]) {
        options.cursor = $searchParams.data["page[after]"];
        options.direction = "forward";
      }

      if ($searchParams.data["page[before]"]) {
        options.cursor = $searchParams.data["page[before]"];
        options.direction = "backward";
      }

      // filters
      if (environment) {
        options.environments = [environment.id];
      } else {
        if ($searchParams.data["filter[env]"]) {
          const environments = await this._prisma.runtimeEnvironment.findMany({
            where: {
              projectId: project.id,
              slug: {
                in: $searchParams.data["filter[env]"],
              },
            },
          });

          options.environments = environments.map((env) => env.id);
        }
      }

      if ($searchParams.data["filter[status]"]) {
        options.statuses = $searchParams.data["filter[status]"].flatMap((status) =>
          ApiRunListPresenter.apiStatusToRunStatuses(status)
        );
      }

      if ($searchParams.data["filter[taskIdentifier]"]) {
        options.tasks = $searchParams.data["filter[taskIdentifier]"];
      }

      if ($searchParams.data["filter[version]"]) {
        options.versions = $searchParams.data["filter[version]"];
      }

      if ($searchParams.data["filter[tag]"]) {
        options.tags = $searchParams.data["filter[tag]"];
      }

      if ($searchParams.data["filter[bulkAction]"]) {
        options.bulkId = $searchParams.data["filter[bulkAction]"];
      }

      if ($searchParams.data["filter[schedule]"]) {
        options.scheduleId = $searchParams.data["filter[schedule]"];
      }

      if ($searchParams.data["filter[createdAt][from]"]) {
        options.from = $searchParams.data["filter[createdAt][from]"].getTime();
      }

      if ($searchParams.data["filter[createdAt][to]"]) {
        options.to = $searchParams.data["filter[createdAt][to]"].getTime();
      }

      if ($searchParams.data["filter[createdAt][period]"]) {
        options.period = $searchParams.data["filter[createdAt][period]"];
      }

      if (typeof $searchParams.data["filter[isTest]"] === "boolean") {
        options.isTest = $searchParams.data["filter[isTest]"];
      }

      const presenter = new RunListPresenter();

      logger.debug("Calling RunListPresenter", { options });

      const results = await presenter.call(options);

      const data: ListRunResponseItem[] = results.runs.map((run) => {
        return {
          id: run.friendlyId,
          status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status),
          taskIdentifier: run.taskIdentifier,
          idempotencyKey: run.idempotencyKey,
          version: run.version ?? undefined,
          createdAt: new Date(run.createdAt),
          updatedAt: new Date(run.updatedAt),
          startedAt: run.startedAt ? new Date(run.startedAt) : undefined,
          finishedAt: run.finishedAt ? new Date(run.finishedAt) : undefined,
          delayedUntil: run.delayUntil ? new Date(run.delayUntil) : undefined,
          isTest: run.isTest,
          ttl: run.ttl ?? undefined,
          expiredAt: run.expiredAt ? new Date(run.expiredAt) : undefined,
          env: {
            id: run.environment.id,
            name: run.environment.slug,
            user: run.environment.userName,
          },
          tags: run.tags,
          costInCents: run.costInCents,
          baseCostInCents: run.baseCostInCents,
          durationMs: run.usageDurationMs,
          ...ApiRetrieveRunPresenter.apiBooleanHelpersFromRunStatus(
            ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status)
          ),
        };
      });

      return {
        data,
        pagination: {
          next: results.pagination.next,
          previous: results.pagination.previous,
        },
      };
    });
  }

  static apiStatusToRunStatuses(status: RunStatus): TaskRunStatus[] | TaskRunStatus {
    switch (status) {
      case "DELAYED":
        return "DELAYED";
      case "WAITING_FOR_DEPLOY": {
        return "WAITING_FOR_DEPLOY";
      }
      case "QUEUED": {
        return "PENDING";
      }
      case "EXECUTING": {
        return "EXECUTING";
      }
      case "REATTEMPTING": {
        return "RETRYING_AFTER_FAILURE";
      }
      case "FROZEN": {
        return ["PAUSED", "WAITING_TO_RESUME"];
      }
      case "CANCELED": {
        return "CANCELED";
      }
      case "COMPLETED": {
        return "COMPLETED_SUCCESSFULLY";
      }
      case "SYSTEM_FAILURE": {
        return "SYSTEM_FAILURE";
      }
      case "INTERRUPTED": {
        return "INTERRUPTED";
      }
      case "CRASHED": {
        return "CRASHED";
      }
      case "FAILED": {
        return "COMPLETED_WITH_ERRORS";
      }
      case "EXPIRED": {
        return "EXPIRED";
      }
      default: {
        assertNever(status);
      }
    }
  }
}
