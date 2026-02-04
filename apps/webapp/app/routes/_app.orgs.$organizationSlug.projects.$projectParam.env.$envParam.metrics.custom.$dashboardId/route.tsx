import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useNavigation } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  LayoutItem,
  MetricDashboardPresenter,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import { QueryPresenter } from "~/presenters/v3/QueryPresenter.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, queryPath, v3BuiltInDashboardPath } from "~/utils/pathBuilder";
import { MetricDashboard } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.metrics.$dashboardKey/route";
import { IconEdit } from "@tabler/icons-react";
import { QueryEditor } from "~/components/query/QueryEditor";
import type { QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { defaultChartConfig } from "~/components/code/ChartConfigPanel";

const ParamSchema = EnvironmentParamSchema.extend({
  dashboardId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam, dashboardId } = ParamSchema.parse(params);

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

  const dashboardPresenter = new MetricDashboardPresenter();
  const dashboard = await dashboardPresenter.customDashboard({
    friendlyId: dashboardId,
    organizationId: project.organizationId,
  });

  // Load query-related data for the editor
  const queryPresenter = new QueryPresenter();
  const { defaultQuery, history } = await queryPresenter.call({
    organizationId: project.organizationId,
  });

  // Admins and impersonating users can use EXPLAIN
  const isAdmin = user.admin || user.isImpersonating;

  return typedjson({
    ...dashboard,
    // Query editor data
    queryDefaultQuery: defaultQuery,
    queryHistory: history,
    isAdmin,
    maxRows: env.QUERY_CLICKHOUSE_MAX_RETURNED_ROWS,
  });
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
  const { projectParam, organizationSlug, envParam, dashboardId } = ParamSchema.parse(params);

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
  const action = formData.get("action");

  switch (action) {
    case "delete": {
      await prisma.metricsDashboard.delete({
        where: { id: dashboard.id },
      });

      return redirectWithSuccessMessage(
        v3BuiltInDashboardPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam },
          "overview"
        ),
        request,
        `Deleted "${dashboard.title}" dashboard`
      );
    }
    case "rename": {
      const newTitle = formData.get("title");
      if (typeof newTitle !== "string" || newTitle.trim().length === 0) {
        throw new Response("Title is required", { status: 400 });
      }

      await prisma.metricsDashboard.update({
        where: { id: dashboard.id },
        data: { title: newTitle.trim() },
      });

      return typedjson({ success: true });
    }
    case "layout": {
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
    }
    default: {
      throw new Response("Invalid action", { status: 400 });
    }
  }
};

// Widget data type for edit mode
type WidgetData = {
  title: string;
  query: string;
  display: QueryWidgetConfig;
};

// Editor mode state type
type EditorMode =
  | null
  | { type: "add" }
  | { type: "edit"; widgetId: string; widget: WidgetData };

export default function Page() {
  const {
    friendlyId,
    title,
    layout,
    defaultPeriod,
    queryDefaultQuery,
    queryHistory,
    isAdmin,
    maxRows,
  } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  const fetcher = useFetcher<typeof action>();
  const addWidgetFetcher = useFetcher();
  const updateWidgetFetcher = useFetcher();
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitializedRef = useRef(false);
  const currentLayoutJsonRef = useRef<string>(JSON.stringify(layout.layout));

  // Editor mode state
  const [editorMode, setEditorMode] = useState<EditorMode>(null);

  // Build the query action URL
  const queryActionUrl = queryPath(
    { slug: organization.slug },
    { slug: project.slug },
    { slug: environment.slug }
  );

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

  // Close editor when add/update operation completes
  useEffect(() => {
    if (
      (addWidgetFetcher.state === "idle" && addWidgetFetcher.data) ||
      (updateWidgetFetcher.state === "idle" && updateWidgetFetcher.data)
    ) {
      setEditorMode(null);
    }
  }, [addWidgetFetcher.state, addWidgetFetcher.data, updateWidgetFetcher.state, updateWidgetFetcher.data]);

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
        fetcher.submit({ action: "layout", layout: newLayoutJson }, { method: "POST" });
      }, 500);
    },
    [fetcher]
  );

  const handleEditWidget = useCallback((widgetId: string, widget: WidgetData) => {
    setEditorMode({ type: "edit", widgetId, widget });
  }, []);

  const handleSave = useCallback(
    (data: { title: string; query: string; config: QueryWidgetConfig }) => {
      if (editorMode?.type === "add") {
        // Submit to add-widget action
        addWidgetFetcher.submit(
          {
            title: data.title,
            query: data.query,
            config: JSON.stringify(data.config),
          },
          {
            method: "POST",
            action: `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboards/${friendlyId}/add-widget`,
          }
        );
      } else if (editorMode?.type === "edit") {
        // Submit to update-widget action
        updateWidgetFetcher.submit(
          {
            widgetId: editorMode.widgetId,
            title: data.title,
            query: data.query,
            config: JSON.stringify(data.config),
          },
          {
            method: "POST",
            action: `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboards/${friendlyId}/update-widget`,
          }
        );
      }
    },
    [editorMode, addWidgetFetcher, updateWidgetFetcher, organization.slug, project.slug, environment.slug, friendlyId]
  );

  const handleCloseEditor = useCallback(() => {
    setEditorMode(null);
  }, []);

  // When in editor mode, render the QueryEditor
  if (editorMode) {
    const mode =
      editorMode.type === "add"
        ? { type: "dashboard-add" as const, dashboardId: friendlyId, dashboardName: title }
        : {
            type: "dashboard-edit" as const,
            dashboardId: friendlyId,
            dashboardName: title,
            widgetId: editorMode.widgetId,
            widgetName: editorMode.widget.title,
          };

    // For edit mode, use the widget's existing values as defaults
    const editorDefaultQuery =
      editorMode.type === "edit" ? editorMode.widget.query : queryDefaultQuery;
    const editorDefaultChartConfig =
      editorMode.type === "edit" && editorMode.widget.display.type === "chart"
        ? {
            chartType: editorMode.widget.display.chartType,
            xAxisColumn: editorMode.widget.display.xAxisColumn,
            yAxisColumns: editorMode.widget.display.yAxisColumns,
            groupByColumn: editorMode.widget.display.groupByColumn,
            stacked: editorMode.widget.display.stacked,
            sortByColumn: editorMode.widget.display.sortByColumn,
            sortDirection: editorMode.widget.display.sortDirection,
            aggregation: editorMode.widget.display.aggregation,
          }
        : defaultChartConfig;
    const editorDefaultResultsView =
      editorMode.type === "edit" ? editorMode.widget.display.type : "table";

    return (
      <QueryEditor
        defaultQuery={editorDefaultQuery}
        defaultScope="environment"
        defaultPeriod={defaultPeriod}
        defaultResultsView={editorDefaultResultsView === "chart" ? "graph" : "table"}
        defaultChartConfig={editorDefaultChartConfig}
        history={queryHistory}
        isAdmin={isAdmin}
        maxRows={maxRows}
        queryActionUrl={queryActionUrl}
        mode={mode}
        maxPeriodDays={maxPeriodDays}
        onSave={handleSave}
        onClose={handleCloseEditor}
      />
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={<RenameDashboardDialog title={title} />} />
        <PageAccessories>
          <Button
            variant="tertiary/small"
            LeadingIcon={PlusIcon}
            onClick={() => setEditorMode({ type: "add" })}
          >
            Add chart
          </Button>
          <Popover>
            <PopoverVerticalEllipseTrigger />
            <PopoverContent className="w-fit min-w-[10rem] p-1" align="end">
              <DeleteDashboardDialog title={title} />
            </PopoverContent>
          </Popover>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full">
          <MetricDashboard
            key={friendlyId}
            data={layout}
            defaultPeriod={defaultPeriod}
            editable={true}
            onLayoutChange={handleLayoutChange}
            onEditWidget={handleEditWidget}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}

function RenameDashboardDialog({ title }: { title: string }) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [newTitle, setNewTitle] = useState(title);

  const isRenaming =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "rename";

  // Close dialog when navigation completes
  useEffect(() => {
    if (navigation.state === "idle") {
      setIsOpen(false);
    }
  }, [navigation.state]);

  // Sync newTitle state when title changes (after successful rename)
  useEffect(() => {
    setNewTitle(title);
  }, [title]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <span className="flex items-center gap-1">
        {title}
        <DialogTrigger asChild>
          <button
            type="button"
            className="rounded p-0.5 text-text-dimmed transition focus-custom hover:bg-charcoal-700 hover:text-text-bright"
          >
            <IconEdit className="size-4" />
          </button>
        </DialogTrigger>
      </span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>Rename dashboard</DialogHeader>
        <Form method="post" className="space-y-4 pt-3">
          <input type="hidden" name="action" value="rename" />
          <InputGroup>
            <Label>Title</Label>
            <Input
              name="title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Dashboard title"
              required
              autoFocus
            />
          </InputGroup>
          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant="primary/medium"
                disabled={isRenaming || !newTitle.trim()}
              >
                {isRenaming ? "Saving…" : "Save"}
              </Button>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="tertiary/medium">Cancel</Button>
              </DialogClose>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDashboardDialog({ title }: { title: string }) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);

  const isDeleting =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  // Close dialog when navigation completes
  useEffect(() => {
    if (navigation.state === "idle") {
      setIsOpen(false);
    }
  }, [navigation.state]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={TrashIcon}
          leadingIconClassName="text-rose-500"
          fullWidth
          textAlignLeft
        >
          Delete dashboard
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>Delete dashboard</DialogHeader>
        <div className="mb-2 mt-4 flex flex-col gap-2">
          <Paragraph variant="small">
            Are you sure you want to delete <strong>"{title}"</strong>? This action cannot be undone
            and all widgets on this dashboard will be permanently removed.
          </Paragraph>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="tertiary/medium">Cancel</Button>
          </DialogClose>
          <Form method="post">
            <Button
              type="submit"
              name="action"
              value="delete"
              variant="danger/medium"
              LeadingIcon={TrashIcon}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
