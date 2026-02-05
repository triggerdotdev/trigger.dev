import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { toast } from "sonner";
import { z } from "zod";
import { defaultChartConfig } from "~/components/code/ChartConfigPanel";
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
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { ToastUI } from "~/components/primitives/Toast";
import { QueryEditor, type QueryEditorSaveData } from "~/components/query/QueryEditor";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { useDashboardEditor } from "~/hooks/useDashboardEditor";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import {
  LayoutItem,
  MetricDashboardPresenter,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import { QueryPresenter } from "~/presenters/v3/QueryPresenter.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, queryPath, v3BuiltInDashboardPath } from "~/utils/pathBuilder";
import { MetricDashboard } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.metrics.$dashboardKey/route";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { IconEdit } from "@tabler/icons-react";

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
  const queryPresenter = new QueryPresenter();

  const [dashboard, { defaultQuery, history }, possibleTasks] = await Promise.all([
    dashboardPresenter.customDashboard({
      friendlyId: dashboardId,
      organizationId: project.organizationId,
    }),
    queryPresenter.call({
      organizationId: project.organizationId,
    }),
    getAllTaskIdentifiers($replica, environment.id),
  ]);

  // Admins and impersonating users can use EXPLAIN
  const isAdmin = user.admin || user.isImpersonating;

  return typedjson({
    ...dashboard,
    // Query editor data
    queryDefaultQuery: defaultQuery,
    queryHistory: history,
    isAdmin,
    maxRows: env.QUERY_CLICKHOUSE_MAX_RETURNED_ROWS,
    possibleTasks: possibleTasks
      .map((task) => ({ slug: task.slug, triggerSource: task.triggerSource }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
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

export default function Page() {
  const {
    friendlyId,
    title,
    layout: dashboardLayout,
    defaultPeriod,
    queryDefaultQuery,
    queryHistory,
    isAdmin,
    maxRows,
    possibleTasks,
  } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  // Build the action URLs
  const widgetActionUrl = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboards/${friendlyId}/widgets`;
  const layoutActionUrl = ""; // Uses form action on current route

  // Handle sync errors by showing a toast
  const handleSyncError = useCallback((error: Error, action: string) => {
    const actionMessages: Record<string, string> = {
      add: "Failed to add widget",
      update: "Failed to update widget",
      delete: "Failed to delete widget",
      duplicate: "Failed to duplicate widget",
      layout: "Failed to save layout",
    };

    const message = actionMessages[action] || "Failed to save changes";

    toast.custom((t) => (
      <ToastUI
        variant="error"
        message={`${message}. Your changes may not be saved.`}
        t={t as string}
        title="Sync Error"
      />
    ));
  }, []);

  // Use the dashboard editor hook for all state management
  const { state, actions } = useDashboardEditor({
    initialData: dashboardLayout,
    widgetActionUrl,
    layoutActionUrl,
    onSyncError: handleSyncError,
  });

  // Build the query action URL for the editor
  const queryActionUrl = queryPath(
    { slug: organization.slug },
    { slug: project.slug },
    { slug: environment.slug }
  );

  // Handle save from the QueryEditor
  const handleSave = useCallback(
    (data: QueryEditorSaveData) => {
      if (state.editorMode?.type === "add") {
        actions.addWidget(data.title, data.query, data.config);
      } else if (state.editorMode?.type === "edit") {
        actions.updateWidget(state.editorMode.widgetId, data.title, data.query, data.config);
      }
    },
    [state.editorMode, actions]
  );

  // Render save button for the QueryEditor
  const renderSaveForm = useCallback(
    (data: QueryEditorSaveData) => {
      const isAdd = state.editorMode?.type === "add";

      return (
        <Button
          type="button"
          variant="primary/small"
          disabled={!data.query}
          onClick={() => handleSave(data)}
        >
          {isAdd ? "Add to dashboard" : "Save changes"}
        </Button>
      );
    },
    [state.editorMode, handleSave]
  );

  // Prepare editor props when in editor mode
  const editorProps = state.editorMode
    ? (() => {
        const mode =
          state.editorMode.type === "add"
            ? { type: "dashboard-add" as const, dashboardId: friendlyId, dashboardName: title }
            : {
                type: "dashboard-edit" as const,
                dashboardId: friendlyId,
                dashboardName: title,
                widgetId: state.editorMode.widgetId,
                widgetName: state.editorMode.widget.title,
              };

        // For edit mode, use the widget's existing values as defaults
        const editorDefaultQuery =
          state.editorMode.type === "edit" ? state.editorMode.widget.query : queryDefaultQuery;
        const editorDefaultChartConfig =
          state.editorMode.type === "edit" && state.editorMode.widget.display.type === "chart"
            ? {
                chartType: state.editorMode.widget.display.chartType,
                xAxisColumn: state.editorMode.widget.display.xAxisColumn,
                yAxisColumns: state.editorMode.widget.display.yAxisColumns,
                groupByColumn: state.editorMode.widget.display.groupByColumn,
                stacked: state.editorMode.widget.display.stacked,
                sortByColumn: state.editorMode.widget.display.sortByColumn,
                sortDirection: state.editorMode.widget.display.sortDirection,
                aggregation: state.editorMode.widget.display.aggregation,
              }
            : defaultChartConfig;
        const editorDefaultResultsView =
          state.editorMode.type === "edit" ? state.editorMode.widget.display.type : "table";
        // Pass the existing result data when editing
        const editorDefaultData =
          state.editorMode.type === "edit" ? state.editorMode.widget.resultData : undefined;

        return {
          mode,
          editorDefaultQuery,
          editorDefaultChartConfig,
          editorDefaultResultsView,
          editorDefaultData,
        };
      })()
    : null;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={title} />
        <PageAccessories>
          <Button variant="secondary/small" LeadingIcon={PlusIcon} onClick={actions.openAddEditor}>
            Add chart
          </Button>
          <Popover>
            <PopoverVerticalEllipseTrigger variant="secondary" />
            <PopoverContent className="w-fit min-w-[10rem] p-1" align="end">
              <div className="flex flex-col gap-1">
                <RenameDashboardDialog title={title} />
                <DeleteDashboardDialog title={title} />
              </div>
            </PopoverContent>
          </Popover>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full">
          <MetricDashboard
            key={friendlyId}
            layout={state.layout}
            widgets={state.widgets}
            defaultPeriod={defaultPeriod}
            editable={true}
            possibleTasks={possibleTasks}
            onLayoutChange={actions.updateLayout}
            onEditWidget={actions.openEditEditor}
            onRenameWidget={actions.renameWidget}
            onDeleteWidget={actions.deleteWidget}
            onDuplicateWidget={actions.duplicateWidget}
          />
        </div>
      </PageBody>

      {/* Query Editor Sheet - opens on top of the dashboard */}
      <Sheet open={!!state.editorMode} onOpenChange={(open) => !open && actions.closeEditor()}>
        <SheetContent
          side="right"
          className="w-[90vw] max-w-none border-l border-grid-dimmed p-0 sm:max-w-none"
        >
          {editorProps && (
            <QueryEditor
              defaultQuery={editorProps.editorDefaultQuery}
              defaultScope="environment"
              defaultPeriod={defaultPeriod}
              defaultResultsView={
                editorProps.editorDefaultResultsView === "chart" ? "graph" : "table"
              }
              defaultChartConfig={editorProps.editorDefaultChartConfig}
              defaultData={editorProps.editorDefaultData}
              history={queryHistory}
              isAdmin={isAdmin}
              maxRows={maxRows}
              queryActionUrl={queryActionUrl}
              mode={editorProps.mode}
              maxPeriodDays={maxPeriodDays}
              save={renderSaveForm}
              onClose={actions.closeEditor}
            />
          )}
        </SheetContent>
      </Sheet>
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
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={IconEdit}
          fullWidth
          textAlignLeft
          className="pl-0.5 pr-3"
          leadingIconClassName="gap-x-0"
        >
          Rename dashboard
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>Rename dashboard</DialogHeader>
        <Form method="post" className="space-y-4">
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
