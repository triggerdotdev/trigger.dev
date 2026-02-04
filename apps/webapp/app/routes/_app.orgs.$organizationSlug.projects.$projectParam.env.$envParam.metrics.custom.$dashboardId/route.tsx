import { TrashIcon } from "@heroicons/react/20/solid";
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
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  LayoutItem,
  MetricDashboardPresenter,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3BuiltInDashboardPath } from "~/utils/pathBuilder";
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
  const { friendlyId, title, layout, defaultPeriod } = useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitializedRef = useRef(false);
  const currentLayoutJsonRef = useRef<string>(JSON.stringify(layout.layout));

  const isDeleting =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  // Close dialog when navigation completes (after successful delete)
  useEffect(() => {
    if (navigation.state === "idle") {
      setIsDeleteDialogOpen(false);
    }
  }, [navigation.state]);

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
        fetcher.submit({ action: "layout", layout: newLayoutJson }, { method: "POST" });
      }, 500);
    },
    [fetcher]
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={title} />
        <PageAccessories>
          <Popover>
            <PopoverVerticalEllipseTrigger />
            <PopoverContent className="w-fit min-w-[10rem] p-1" align="end">
              <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
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
                      Are you sure you want to delete <strong>"{title}"</strong>? This action cannot
                      be undone and all widgets on this dashboard will be permanently removed.
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
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}
