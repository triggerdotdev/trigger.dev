import { type ActionFunctionArgs, type LoaderFunctionArgs, redirect } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useRef } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  LayoutItem,
  MetricDashboardPresenter,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { MetricDashboard } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.metrics.$dashboardKey/route";

const ParamSchema = EnvironmentParamSchema.extend({
  dashboardId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, dashboardId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new MetricDashboardPresenter();
  const dashboard = await presenter.customDashboard({
    friendlyId: dashboardId,
    organizationId: project.organizationId,
  });

  return typedjson(dashboard);
};

const SaveLayoutSchema = z.object({
  layout: z.string().transform((str, ctx) => {
    try {
      const parsed = JSON.parse(str);
      const result = z.array(LayoutItem).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid layout format",
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, dashboardId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  // Load the dashboard
  const dashboard = await prisma.metricsDashboard.findFirst({
    where: {
      friendlyId: dashboardId,
      organizationId: project.organizationId,
    },
  });

  if (!dashboard) {
    throw new Response("Dashboard not found", { status: 404 });
  }

  const formData = await request.formData();
  const result = SaveLayoutSchema.safeParse({
    layout: formData.get("layout"),
  });

  if (!result.success) {
    throw new Response("Invalid form data: " + result.error.message, { status: 400 });
  }

  // Parse existing layout to preserve widgets
  const existingLayout = JSON.parse(dashboard.layout) as Record<string, unknown>;

  // Update layout positions while preserving widgets
  const updatedLayout = {
    ...existingLayout,
    layout: result.data.layout,
  };

  // Save to database
  await prisma.metricsDashboard.update({
    where: { id: dashboard.id },
    data: {
      layout: JSON.stringify(updatedLayout),
    },
  });

  return typedjson({ success: true });
};

export default function Page() {
  const { friendlyId, title, layout, defaultPeriod } = useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitializedRef = useRef(false);
  const currentLayoutJsonRef = useRef<string>(JSON.stringify(layout.layout));

  // Track when the dashboard data changes (e.g., switching dashboards)
  const layoutJson = JSON.stringify(layout.layout);
  useEffect(() => {
    // Cancel any pending save when switching dashboards
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }

    // Update the current layout reference and mark as not yet user-modified
    currentLayoutJsonRef.current = layoutJson;
    isInitializedRef.current = false;

    // Allow saves after a short delay to skip initial mount callbacks
    const initTimeout = setTimeout(() => {
      isInitializedRef.current = true;
    }, 100);

    return () => {
      clearTimeout(initTimeout);
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [layoutJson]);

  const handleLayoutChange = useCallback(
    (newLayout: LayoutItem[]) => {
      // Skip if not yet initialized (prevents saving during mount/navigation)
      if (!isInitializedRef.current) {
        return;
      }

      const newLayoutJson = JSON.stringify(newLayout);

      // Skip if layout hasn't actually changed
      if (newLayoutJson === currentLayoutJsonRef.current) {
        return;
      }

      // Clear existing timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Debounce auto-save by 500ms
      debounceTimeoutRef.current = setTimeout(() => {
        currentLayoutJsonRef.current = newLayoutJson;
        fetcher.submit({ layout: newLayoutJson }, { method: "POST" });
      }, 500);
    },
    [fetcher]
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={title} />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full">
          <MetricDashboard
            key={friendlyId}
            data={layout}
            defaultPeriod={defaultPeriod}
            editable={true}
            onLayoutChange={handleLayoutChange}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}
