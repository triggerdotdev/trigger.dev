import { PencilSquareIcon } from "@heroicons/react/20/solid";
import { type ActionFunctionArgs, type LoaderFunctionArgs, redirect } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { useCallback, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
  const { title, layout, defaultPeriod } = useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [isEditing, setIsEditing] = useState(false);
  const [pendingLayout, setPendingLayout] = useState<LayoutItem[] | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const isSaving = fetcher.state === "submitting";

  const handleLayoutChange = useCallback((newLayout: LayoutItem[]) => {
    setPendingLayout(newLayout);
  }, []);

  const handleEdit = () => {
    setIsEditing(true);
    setPendingLayout(null);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setPendingLayout(null);
    // Increment key to force remount and reset layout to original
    setResetKey((k) => k + 1);
  };

  const handleSave = () => {
    if (!pendingLayout) {
      // No changes made, just exit edit mode
      setIsEditing(false);
      return;
    }

    fetcher.submit({ layout: JSON.stringify(pendingLayout) }, { method: "POST" });

    setIsEditing(false);
    setPendingLayout(null);
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={title} />
        <PageAccessories>
          {isEditing ? (
            <div className="flex items-center gap-2">
              <Button variant="tertiary/small" onClick={handleCancel} disabled={isSaving}>
                Cancel
              </Button>
              <Button variant="primary/small" onClick={handleSave} disabled={isSaving}>
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          ) : (
            <Button variant="tertiary/small" LeadingIcon={PencilSquareIcon} onClick={handleEdit}>
              Edit
            </Button>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full">
          <MetricDashboard
            key={resetKey}
            data={layout}
            defaultPeriod={defaultPeriod}
            editable={isEditing}
            onLayoutChange={handleLayoutChange}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}
