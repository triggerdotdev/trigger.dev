// The New alert dialog with Email selected, in Production. Copied from the rendered dashboard; the
// Email field is drawn from the route's source (the test dashboard has no email integration, so it
// showed a warning there). The webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import type { ReactNode } from "react";
import { Button, EnvCombo } from "./chrome";
import { CheckboxBox, DialogFrame, FormButtons, Segment } from "./form-parts";
import * as I from "./icons";

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";

function AlertType({ children, padRight = "pr-4" }: { children: ReactNode; padRight?: string }) {
  return (
    <span className={`group flex items-start gap-x-2 w-fit ${padRight}`}>
      <CheckboxBox checked />
      <div>
        <div className="flex items-center gap-x-2">
          <span className="text-sm text-text-bright mt-0.5">{children}</span>
        </div>
      </div>
    </span>
  );
}

export function AlertsNewFigure() {
  return (
    <DialogFrame title="New alert">
      <div>
        <div className="flex flex-col gap-y-5 mt-2">
          <div className="grid items-center gap-1.5 w-full">
            <div
              data-mark="channel"
              data-mark-badge="below"
              className="flex rounded text-text-bright h-10 bg-segmented-track w-full"
            >
              <div className="w-full">
                <div className="flex h-full w-full items-center justify-between p-1 gap-x-0.5">
                  <Segment size="medium" selected>
                    <div>Email</div>
                  </Segment>
                  <Segment size="medium">
                    <div>Slack</div>
                  </Segment>
                  <Segment size="medium">
                    <div>Webhook</div>
                  </Segment>
                </div>
              </div>
            </div>
          </div>
          <div className="grid w-full items-center gap-1.5">
            <span className={label}>Email</span>
            <div className="flex items-center px-1 h-8 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg">
              <div className="grow h-full w-full px-1.5 rounded text-sm leading-8 text-text-dimmed">
                email@youremail.com
              </div>
            </div>
          </div>
          <div data-mark="alert-types" className="grid w-full items-center gap-1.5 max-w-md">
            <span className={label}>Alert me when</span>
            <div className="flex items-center gap-1">
              <AlertType padRight="pr-0">Task runs fail</AlertType>
              <div className="h-fit">
                <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
              </div>
            </div>
            <AlertType>Deployments fail</AlertType>
            <AlertType>Deployments succeed</AlertType>
          </div>
          <div className="grid w-full items-center gap-1.5 max-w-md">
            <span className={label}>Environment</span>
            <EnvCombo env="prod" />
          </div>
          <FormButtons
            cancel={<Button size="medium">Cancel</Button>}
            confirm={
              <Button variant="primary" size="medium" mark="save" markBadge="left">
                Save
              </Button>
            }
          />
        </div>
      </div>
    </DialogFrame>
  );
}
