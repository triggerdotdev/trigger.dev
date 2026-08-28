import { json } from "@remix-run/server-runtime";
import { ReportPresenter } from "~/presenters/v3/reports/ReportPresenter.server";
import { isReportKey, REPORT_KEYS } from "~/presenters/v3/reports/report-registry";
import {
  ReportParamsSchema,
  ReportSearchParamsSchema,
  reportResponse,
} from "~/presenters/v3/reports/reportsApi.server";
import { reportAuthResource } from "~/presenters/v3/reports/reportsApiAuth.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// Only `loader` may be exported here; the vite build flags server code reachable from a
// non-loader export. Schemas and helpers live in reportsApi.server.ts.
export const loader = createLoaderApiRoute(
  {
    params: ReportParamsSchema,
    searchParams: ReportSearchParamsSchema,
    // The MCP `get_report` tool calls this with a scoped JWT (read:query), so JWT auth
    // must be allowed — same as api.v1.query.ts.
    allowJWT: true,
    findResource: async () => 1, // dummy — report key validated in the handler
    authorization: {
      action: "read",
      resource: (_, params) => reportAuthResource(params.key),
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

      return reportResponse(vm, searchParams.format);
    } catch (error) {
      logger.error("Failed to render report", { error, key: params.key });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);
