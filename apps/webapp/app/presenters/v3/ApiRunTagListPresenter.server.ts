import { Project, RuntimeEnvironment } from "@trigger.dev/database";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";
import { RunTagListPresenter, TagListOptions } from "./RunTagListPresenter.server";

const SearchParamsSchema = z.object({
  "page[size]": z.coerce.number().int().positive().min(1).max(100).optional(),
  "page[number]": z.coerce.number().int().positive().min(1).optional(),
  "filter[name]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
  "filter[env]": z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
});

type SearchParamsSchema = z.infer<typeof SearchParamsSchema>;

export class ApiRunTagListPresenter extends BasePresenter {
  public async call(
    project: Project,
    searchParams: URLSearchParams,
    environment?: RuntimeEnvironment
  ) {
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

      const options: TagListOptions = {
        projectId: project.id,
      };

      // pagination
      if ($searchParams.data["page[size]"]) {
        options.pageSize = $searchParams.data["page[size]"];
      }

      if ($searchParams.data["page[number]"]) {
        options.page = $searchParams.data["page[number]"];
      }

      // filters
      if (environment) {
        options.environments = [environment.id];
      }

      if ($searchParams.data["filter[name]"]) {
        options.names = $searchParams.data["filter[name]"];
      }

      const presenter = new RunTagListPresenter();

      logger.debug("Calling RunTagListPresenter", { options });

      const results = await presenter.call(options);

      return {
        tags: results.tags,
        pagination: {
          page: results.currentPage,
          hasMore: results.hasMore,
        },
      };
    });
  }
}
