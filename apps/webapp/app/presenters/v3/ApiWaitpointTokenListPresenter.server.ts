import { RuntimeEnvironmentType, WaitpointTokenStatus } from "@trigger.dev/core/v3";
import { z } from "zod";
import { BasePresenter } from "./basePresenter.server";
import { CoercedDate } from "~/utils/zod";
import { AuthenticatedEnvironment } from "@internal/run-engine";
import {
  WaitpointTokenListOptions,
  WaitpointTokenListPresenter,
} from "./WaitpointTokenListPresenter.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { RunEngineVersion } from "@trigger.dev/database";

export const ApiWaitpointTokenListSearchParams = z.object({
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
      const parsedStatuses = statuses.map((status) => WaitpointTokenStatus.safeParse(status));

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
  "filter[idempotencyKey]": z.string().optional(),
  "filter[tags]": z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      return value.split(",");
    }),
  "filter[createdAt][period]": z.string().optional(),
  "filter[createdAt][from]": CoercedDate,
  "filter[createdAt][to]": CoercedDate,
});

type ApiWaitpointTokenListSearchParams = z.infer<typeof ApiWaitpointTokenListSearchParams>;

export class ApiWaitpointTokenListPresenter extends BasePresenter {
  public async call(
    environment: {
      id: string;
      type: RuntimeEnvironmentType;
      project: {
        id: string;
        engine: RunEngineVersion;
      };
    },
    searchParams: ApiWaitpointTokenListSearchParams
  ) {
    return this.trace("call", async (span) => {
      const options: WaitpointTokenListOptions = {
        environment,
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

      if (searchParams["filter[status]"]) {
        options.statuses = searchParams["filter[status]"];
      }

      if (searchParams["filter[idempotencyKey]"]) {
        options.idempotencyKey = searchParams["filter[idempotencyKey]"];
      }

      if (searchParams["filter[tags]"]) {
        options.tags = searchParams["filter[tags]"];
      }

      if (searchParams["filter[createdAt][period]"]) {
        options.period = searchParams["filter[createdAt][period]"];
      }

      if (searchParams["filter[createdAt][from]"]) {
        options.from = searchParams["filter[createdAt][from]"].getTime();
      }

      if (searchParams["filter[createdAt][to]"]) {
        options.to = searchParams["filter[createdAt][to]"].getTime();
      }

      const presenter = new WaitpointTokenListPresenter();
      const result = await presenter.call(options);

      if (!result.success) {
        throw new ServiceValidationError(result.error);
      }

      return {
        data: result.tokens,
        pagination: result.pagination,
      };
    });
  }
}
