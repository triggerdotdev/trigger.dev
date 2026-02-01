import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import {
  type DashboardLayout,
  MetricDashboardPresenter,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import { type LoaderFunctionArgs } from "@remix-run/node";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { z } from "zod";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { MetricWidget } from "../resources.metric";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { TimeFilter, timeFilterFromTo, timeFilters } from "~/components/runs/v3/SharedFilters";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { useSearchParams } from "~/hooks/useSearchParam";
import parse from "parse-duration";

const ParamSchema = EnvironmentParamSchema.extend({
  dashboardKey: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam, dashboardKey } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new MetricDashboardPresenter();
  const dashboard = await presenter.builtInDashboard({
    organizationId: project.organizationId,
    key: dashboardKey,
  });

  return typedjson(dashboard);
};

export default function Page() {
  const { title, layout, defaultPeriod } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={title} />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full">
          <MetricDashboard layout={layout} defaultPeriod={defaultPeriod} />
        </div>
      </PageBody>
    </PageContainer>
  );
}

function determineRefreshIntervalMs(props: {
  period?: string;
  from?: string;
  to?: string;
}): number {
  const { from, to } = timeFilterFromTo({ ...props, defaultPeriod: "7d" });
  const intervalMs = to.getTime() - from.getTime();

  //Refresh 4 times in the period
  return intervalMs / 4;
}

function MetricDashboard({
  layout,
  defaultPeriod,
}: {
  layout: DashboardLayout;
  defaultPeriod: string;
}) {
  const { value } = useSearchParams();
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  const period = value("period");
  const from = value("from");
  const to = value("to");

  const refreshIntervalMs = determineRefreshIntervalMs({ period, from, to });

  return (
    <div className="grid grid-rows-[auto_1fr]">
      <div className="flex items-center">
        <TimeFilter
          defaultPeriod={defaultPeriod}
          labelName="Period"
          hideLabel
          maxPeriodDays={maxPeriodDays}
        />
      </div>
      {/* @ts-expect-error TODO fix this legacy ref */}
      <div ref={containerRef}>
        {mounted && (
          <ReactGridLayout
            layout={layout.layout}
            width={width}
            gridConfig={{ cols: 12, rowHeight: 30 }}
          >
            {Object.entries(layout.widgets).map(([key, widget]) => (
              <div key={key}>
                <MetricWidget
                  title={widget.title}
                  query={widget.query}
                  scope="environment"
                  period={period ?? null}
                  from={from ?? null}
                  to={to ?? null}
                  config={widget.display}
                  organizationId={organization.id}
                  projectId={project.id}
                  environmentId={environment.id}
                  refreshIntervalMs={refreshIntervalMs}
                />
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </div>
  );
}
