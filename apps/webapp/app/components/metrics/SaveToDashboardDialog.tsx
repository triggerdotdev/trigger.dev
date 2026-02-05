import { ChartBarSquareIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { useEnvironment } from "~/hooks/useEnvironment";
import {
  useCustomDashboards,
  useWidgetLimitPerDashboard,
} from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useOrganization } from "~/hooks/useOrganizations";
import { Button } from "../primitives/Buttons";
import { Dialog, DialogContent, DialogHeader } from "../primitives/Dialog";
import { FormButtons } from "../primitives/FormButtons";
import { Paragraph } from "../primitives/Paragraph";
import { cn } from "~/utils/cn";
import type { QueryWidgetConfig } from "./QueryWidget";

export type SaveToDashboardDialogProps = {
  title: string;
  query: string;
  config: QueryWidgetConfig;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SaveToDashboardDialog({
  title,
  query,
  config,
  isOpen,
  onOpenChange,
}: SaveToDashboardDialogProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const customDashboards = useCustomDashboards();
  const widgetLimit = useWidgetLimitPerDashboard();
  const navigation = useNavigation();

  // Find the first dashboard that isn't at the widget limit
  const firstAvailableDashboard = customDashboards.find((d) => d.widgetCount < widgetLimit);

  const [selectedDashboardId, setSelectedDashboardId] = useState<string | null>(
    firstAvailableDashboard?.friendlyId ?? (customDashboards[0]?.friendlyId ?? null)
  );

  // Build the form action URL
  const formAction = selectedDashboardId
    ? `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboards/${selectedDashboardId}/widgets`
    : "";

  const isLoading = navigation.formAction === formAction && navigation.state === "submitting";

  // Check if selected dashboard is at widget limit
  const selectedDashboard = customDashboards.find((d) => d.friendlyId === selectedDashboardId);
  const isSelectedAtLimit = selectedDashboard ? selectedDashboard.widgetCount >= widgetLimit : false;

  // Close dialog when navigation completes (redirect is happening)
  useEffect(() => {
    if (navigation.formAction === formAction && navigation.state === "loading") {
      onOpenChange(false);
    }
  }, [navigation.formAction, navigation.state, formAction, onOpenChange]);

  // Update selection if dashboards change
  useEffect(() => {
    if (customDashboards.length > 0 && !selectedDashboardId) {
      const available = customDashboards.find((d) => d.widgetCount < widgetLimit);
      setSelectedDashboardId(available?.friendlyId ?? customDashboards[0].friendlyId);
    }
  }, [customDashboards, selectedDashboardId, widgetLimit]);

  if (customDashboards.length === 0) {
    return (
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>Save to Dashboard</DialogHeader>
          <div className="space-y-4 pt-3">
            <Paragraph variant="small" className="text-text-dimmed">
              You don't have any custom dashboards yet. Create one first from the sidebar menu.
            </Paragraph>
            <FormButtons
              cancelButton={
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Close</Button>
                </DialogClose>
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>Save to Dashboard</DialogHeader>
        <Form method="post" action={formAction} className="space-y-4 pt-3">
          <input type="hidden" name="action" value="add" />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="query" value={query} />
          <input type="hidden" name="config" value={JSON.stringify(config)} />

          <div className="space-y-2">
            <Paragraph variant="small" className="text-text-dimmed">
              Select a dashboard to add this widget to:
            </Paragraph>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {customDashboards.map((dashboard) => {
                const isAtLimit = dashboard.widgetCount >= widgetLimit;
                return (
                  <button
                    key={dashboard.friendlyId}
                    type="button"
                    onClick={() => !isAtLimit && setSelectedDashboardId(dashboard.friendlyId)}
                    disabled={isAtLimit}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition",
                      isAtLimit
                        ? "cursor-not-allowed opacity-50"
                        : selectedDashboardId === dashboard.friendlyId
                          ? "bg-charcoal-700 text-text-bright"
                          : "text-text-dimmed hover:bg-charcoal-750 hover:text-text-bright"
                    )}
                  >
                    <ChartBarSquareIcon className="size-4 shrink-0 text-purple-500" />
                    <span className="flex-1 truncate">{dashboard.title}</span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        isAtLimit ? "text-error" : "text-text-dimmed"
                      )}
                    >
                      {dashboard.widgetCount}/{widgetLimit}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant="primary/medium"
                disabled={isLoading || !selectedDashboardId || isSelectedAtLimit}
              >
                {isLoading ? "Saving..." : "Save"}
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
