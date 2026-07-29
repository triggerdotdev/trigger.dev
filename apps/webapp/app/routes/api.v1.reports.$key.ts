import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ReportPresenter } from "~/presenters/v3/reports/ReportPresenter.server";
import { isReportKey, REPORT_KEYS } from "~/presenters/v3/reports/report-registry";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute, everyResource } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  key: z.string(),
});

/**
 * The query tables the reports read. Authorize per-table (like api.v1.query.ts) rather than
 * the permissive `{ type: "query", id: "all" }`: a JWT must be scoped to every table a report
 * touches, so a token scoped to only some tables can't fetch a report that reads others. This
 * is the union across reports; `health` reads all three.
 */
const REPORT_QUERY_TABLES = ["runs", "env_metrics", "queue_metrics"] as const;

/** Canonical shorthand ("1h" / "30m" / "7d") with an upper bound, so the public API rejects
 *  garbage and absurd ranges (e.g. "999999999d") itself rather than relying on downstream clip. */
const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const MAX_PERIOD_MS = 90 * UNIT_MS.d;
const PeriodSchema = z
  .string()
  .regex(/^[1-9]\d*[smhdw]$/, "period must be a shorthand like '1h', '30m', or '7d'")
  .refine(
    (p) => Number(p.slice(0, -1)) * UNIT_MS[p.slice(-1)] <= MAX_PERIOD_MS,
    "period is too large (max 90d)"
  );

const SearchParamsSchema = z.object({
  period: PeriodSchema.optional(),
  // markdown (default) for CLI/MCP · json (the raw VM) for web · ansi for a colour terminal.
  format: z.enum(["markdown", "json", "ansi"]).default("markdown"),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchParamsSchema,
    // The MCP `get_report` tool calls this with a scoped JWT (read:query), so JWT auth
    // must be allowed — same as api.v1.query.ts.
    allowJWT: true,
    findResource: async () => 1, // dummy — report key validated in the handler
    authorization: {
      action: "read",
      // Per-table, not `id: "all"`: a JWT must be scoped to every query table the report reads.
      resource: () => everyResource(REPORT_QUERY_TABLES.map((id) => ({ type: "query", id }))),
    },
  },
  async ({ params, searchParams, authentication }) => {
    if (!isReportKey(params.key)) {
      return json(
        { error: `Unknown report "${params.key}". Available: ${REPORT_KEYS.join(", ")}.` },
        { status: 404 }
      );
    }

    try {
      const presenter = new ReportPresenter();
      const vm = await presenter.call({
        environment: authentication.environment,
        key: params.key,
        period: searchParams.period,
      });

      if (!vm) {
        return json({ error: `Unknown report "${params.key}".` }, { status: 404 });
      }

      if (searchParams.format === "json") {
        return json(vm, { status: 200 });
      }

      if (searchParams.format === "ansi") {
        return new Response(renderReportAnsi(vm), {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      return new Response(renderReportMarkdown(vm), {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    } catch (error) {
      logger.error("Failed to render report", { error, key: params.key });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);
