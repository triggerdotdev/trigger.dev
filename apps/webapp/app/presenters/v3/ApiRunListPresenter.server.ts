import {
  type ListRunResponse,
  type ListRunResponseItem,
  MachinePresetName,
  parsePacket,
  RunStatus,
} from "@trigger.dev/core/v3";
import { type Project, type RuntimeEnvironment, type TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { z } from "zod";
import { API_VERSIONS, RunStatusUnspecifiedApiVersion } from "~/api/versions";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { logger } from "~/services/logger.server";
import { CoercedDate } from "~/utils/zod";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { ApiRetrieveRunPresenter } from "./ApiRetrieveRunPresenter.server";
import { NextRunListPresenter, type RunListOptions } from "./NextRunListPresenter.server";
import { BasePresenter } from "./basePresenter.server";

export const ApiRunListSearchParams = z.object({
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
      const parsedStatuses = statuses.map((status) =>
        RunStatus.or(RunStatusUnspecifiedApiVersion).safeParse(status)
      );

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
  "filter[createdAt][from]": CoercedDate,
  "filter[createdAt][to]": CoercedDate,
  "filter[createdAt][period]": z.string().optional(),
  "filter[batch]": z.string().optional(),
  "filter[queue]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
  "filter[machine]": z
    .string()
    .optional()
    .transform((value, ctx) => {
      const values = value ? value.split(",") : undefined;
      if (!values) {
        return undefined;
      }

      const parsedValues = values.map((v) => MachinePresetName.safeParse(v));
      const invalidValues: string[] = [];
      parsedValues.forEach((result, index) => {
        if (!result.success) {
          invalidValues.push(values[index]);
        }
      });
      if (invalidValues.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid machine values: ${invalidValues.join(", ")}`,
        });

        return z.NEVER;
      }

      return parsedValues.map((result) => result.data).filter(Boolean);
    }),
});

type ApiRunListSearchParams = z.infer<typeof ApiRunListSearchParams>;

export class ApiRunListPresenter extends BasePresenter {
  public async call(
    project: Project,
    searchParams: ApiRunListSearchParams,
    apiVersion: API_VERSIONS,
    environment?: RuntimeEnvironment
  ) {
    return this.trace("call", async (span) => {
      const options: RunListOptions = {
        projectId: project.id,
      };

      // pagination
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

      let environmentId: string | undefined;
      let organizationId: string | undefined;

      // filters
      if (environment) {
        environmentId = environment.id;
        organizationId = environment.organizationId;
      } else {
        if (searchParams["filter[env]"]) {
          const environments = await this._replica.runtimeEnvironment.findMany({
            where: {
              projectId: project.id,
              slug: {
                in: searchParams["filter[env]"],
              },
            },
          });

          environmentId = environments.at(0)?.id;
          organizationId = environments.at(0)?.organizationId;
        }
      }

      if (!environmentId) {
        throw new ServiceValidationError("No environment found");
      }

      if (!organizationId) {
        throw new ServiceValidationError("No organization found");
      }

      if (searchParams["filter[status]"]) {
        options.statuses = searchParams["filter[status]"].flatMap((status) =>
          ApiRunListPresenter.apiStatusToRunStatuses(status)
        );
      }

      if (searchParams["filter[taskIdentifier]"]) {
        options.tasks = searchParams["filter[taskIdentifier]"];
      }

      if (searchParams["filter[version]"]) {
        options.versions = searchParams["filter[version]"];
      }

      if (searchParams["filter[tag]"]) {
        options.tags = searchParams["filter[tag]"];
      }

      if (searchParams["filter[bulkAction]"]) {
        options.bulkId = searchParams["filter[bulkAction]"];
      }

      if (searchParams["filter[schedule]"]) {
        options.scheduleId = searchParams["filter[schedule]"];
      }

      if (searchParams["filter[createdAt][from]"]) {
        options.from = searchParams["filter[createdAt][from]"].getTime();
      }

      if (searchParams["filter[createdAt][to]"]) {
        options.to = searchParams["filter[createdAt][to]"].getTime();
      }

      if (searchParams["filter[createdAt][period]"]) {
        options.period = searchParams["filter[createdAt][period]"];
      }

      if (typeof searchParams["filter[isTest]"] === "boolean") {
        options.isTest = searchParams["filter[isTest]"];
      }

      if (searchParams["filter[batch]"]) {
        options.batchId = searchParams["filter[batch]"];
      }

      if (searchParams["filter[queue]"]) {
        options.queues = searchParams["filter[queue]"];
      }

      if (searchParams["filter[machine]"]) {
        options.machines = searchParams["filter[machine]"];
      }

      const presenter = new NextRunListPresenter(this._replica, clickhouseClient);

      logger.debug("Calling RunListPresenter", { options });

      const results = await presenter.call(organizationId, environmentId, options);

      logger.debug("RunListPresenter results", { runs: results.runs.length });

      const data = await Promise.all(
        results.runs.map(async (run) => {
          const metadata = await parsePacket(
            {
              data: run.metadata ?? undefined,
              dataType: run.metadataType,
            },
            {
              filteredKeys: ["$$streams", "$$streamsVersion", "$$streamsBaseUrl"],
            }
          );

          return {
            id: run.friendlyId,
            status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status, apiVersion),
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
            depth: run.depth,
            metadata,
            ...ApiRetrieveRunPresenter.apiBooleanHelpersFromRunStatus(
              ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status, apiVersion)
            ),
          };
        })
      );

      return {
        data,
        pagination: {
          next: results.pagination.next,
          previous: results.pagination.previous,
        },
      };
    });
  }

  static apiStatusToRunStatuses(
    status: RunStatus | RunStatusUnspecifiedApiVersion
  ): TaskRunStatus[] | TaskRunStatus {
    switch (status) {
      case "DELAYED":
        return "DELAYED";
      case "PENDING_VERSION": {
        return "PENDING_VERSION";
      }
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
      case "TIMED_OUT": {
        return "TIMED_OUT";
      }
      case "DEQUEUED": {
        return "DEQUEUED";
      }
      case "WAITING": {
        return "WAITING_TO_RESUME";
      }
      default: {
        assertNever(status);
      }
    }
  }
}
