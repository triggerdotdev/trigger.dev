// The Alerts page in Production before any alert exists: the "Adding alerts" card with the New
// alert button. Copied from the rendered dashboard; the webapp files it mirrors are its `sources`
// in lib/dashboard-figures.ts.
import { BellAlertIcon } from "@heroicons/react/20/solid";
import { AppFrame, Button, PageHeader, SideMenu } from "./chrome";
import * as I from "./icons";

export function AlertsEmptyFigure() {
  return (
    <AppFrame menu={<SideMenu active="Alerts" open={["Manage"]} env="prod" />}>
      <PageHeader title="Alerts">
        <Button variant="docs" icon={I.BookIcon}>
          Alerts docs
        </Button>
      </PageHeader>
      {/* MainCenteredContainer: md:mt-[22vh], written as its value at the 900px-tall viewport. */}
      <div className="mx-auto p-1 mt-[198px] max-w-md">
        <div className="space-y-8">
          <div className="border-grid-bright bg-background-bright rounded-md border p-4 gap-3 flex-col flex h-fit items-start max-w-full">
            <div className="flex items-center gap-2">
              <BellAlertIcon className="size-5 text-alerts" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright">
                Adding alerts
              </div>
              <div className="font-sans text-sm font-medium text-text-dimmed mb-2">
                You can get alerted when deployed runs fail. We currently support sending Slack,
                Email, and webhooks.
              </div>
              <div className="flex items-center justify-between gap-3">
                <Button variant="docs" size="medium" icon={I.BookIcon}>
                  Alerts docs
                </Button>
                <Button
                  variant="primary"
                  size="medium"
                  icon={I.PlusIcon}
                  shortcut="n"
                  mark="new-alert"
                  markBadge="below"
                >
                  New alert
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
