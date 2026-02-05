import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import {
  type LayoutItem,
  type Widget,
  MetricDashboardPresenter,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import { type LoaderFunctionArgs } from "@remix-run/node";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { z } from "zod";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactGridLayout from "react-grid-layout";
import { MetricWidget } from "../resources.metric";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type WidgetData } from "~/components/metrics/QueryWidget";

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
  const { key, title, layout: dashboardLayout, defaultPeriod } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={title} />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full">
          <MetricDashboard
            key={key}
            layout={dashboardLayout.layout}
            widgets={dashboardLayout.widgets}
            defaultPeriod={defaultPeriod}
            editable={false}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}

export function MetricDashboard({
  layout,
  widgets,
  defaultPeriod,
  editable,
  onLayoutChange,
  onEditWidget,
  onDeleteWidget,
  onDuplicateWidget,
}: {
  /** The layout items (positions/sizes) - fully controlled from parent */
  layout: LayoutItem[];
  /** The widget configurations keyed by widget ID - fully controlled from parent */
  widgets: Record<string, Widget>;
  defaultPeriod: string;
  editable: boolean;
  onLayoutChange?: (layout: LayoutItem[]) => void;
  onEditWidget?: (widgetId: string, widget: WidgetData) => void;
  onDeleteWidget?: (widgetId: string) => void;
  onDuplicateWidget?: (widgetId: string, widget: WidgetData) => void;
}) {
  const { value } = useSearchParams();
  const { width, containerRef, mounted } = useContainerWidth();
  const [resizingItemId, setResizingItemId] = useState<string | null>(null);

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  const period = value("period");
  const from = value("from");
  const to = value("to");

  const handleLayoutChange = useCallback(
    (newLayout: readonly LayoutItem[]) => {
      const mutableLayout = [...newLayout];
      onLayoutChange?.(mutableLayout);
    },
    [onLayoutChange]
  );

  return (
    <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
      <div className="flex items-center border-b border-b-grid-bright px-3 py-2">
        <TimeFilter
          defaultPeriod={defaultPeriod}
          labelName="Period"
          hideLabel
          maxPeriodDays={maxPeriodDays}
        />
      </div>
      <div
        ref={containerRef}
        className="overflow-y-auto scrollbar-thin scrollbar-track-charcoal-800 scrollbar-thumb-charcoal-700"
      >
        {mounted && (
          <ReactGridLayout
            layout={layout}
            width={width}
            gridConfig={{ cols: 12, rowHeight: 30 }}
            resizeConfig={{
              enabled: editable,
              handles: ["se"],
            }}
            dragConfig={{ enabled: editable, handle: ".drag-handle" }}
            onLayoutChange={handleLayoutChange}
            onResizeStart={(_layout, oldItem) => setResizingItemId(oldItem?.i ?? null)}
            onResizeStop={() => setResizingItemId(null)}
          >
            {Object.entries(widgets).map(([key, widget]) => (
              <div key={key}>
                <MetricWidget
                  widgetKey={key}
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
                  refreshIntervalMs={60_000}
                  isResizing={resizingItemId === key}
                  isDraggable={editable}
                  onEdit={
                    onEditWidget
                      ? (resultData) => onEditWidget(key, { ...widget, resultData })
                      : undefined
                  }
                  onDelete={onDeleteWidget ? () => onDeleteWidget(key) : undefined}
                  onDuplicate={
                    onDuplicateWidget
                      ? (resultData) => onDuplicateWidget(key, { ...widget, resultData })
                      : undefined
                  }
                />
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </div>
  );
}

function useContainerWidth(initialWidth = 1280) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  const [mounted, setMounted] = useState(false);

  const measureWidth = useCallback(() => {
    if (containerRef.current) {
      setWidth(containerRef.current.offsetWidth);
    }
  }, []);

  useEffect(() => {
    measureWidth();
    setMounted(true);

    const element = containerRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [measureWidth]);

  return { width, containerRef, mounted };
}
