import { BellAlertIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import { v3AlertCreatePath, type AlertDraftPrefillParams } from "~/utils/pathBuilder";

export function ErrorActionsMenu({
  investigatePrompt,
  watchPrefill,
  organization,
  project,
  environment,
}: {
  investigatePrompt: string;
  watchPrefill?: AlertDraftPrefillParams;
  organization: Parameters<typeof v3AlertCreatePath>[0];
  project: Parameters<typeof v3AlertCreatePath>[1];
  environment: Parameters<typeof v3AlertCreatePath>[2];
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const agent = useDashboardAgent();

  if (!agent && !watchPrefill) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverVerticalEllipseTrigger aria-label="Error actions" />
      <PopoverContent align="end" className="min-w-44 p-1">
        {agent && (
          <PopoverMenuItem
            icon={AgentIcon}
            title="Investigate"
            onClick={() => {
              close();
              agent.openWith(investigatePrompt);
            }}
          />
        )}
        {watchPrefill &&
          (agent ? (
            <PopoverMenuItem
              icon={BellAlertIcon}
              leadingIconClassName="text-alerts"
              title="Watch"
              onClick={() => {
                close();
                agent.openCreateAlert(watchPrefill);
              }}
            />
          ) : (
            <PopoverMenuItem
              icon={BellAlertIcon}
              leadingIconClassName="text-alerts"
              title="Watch"
              to={v3AlertCreatePath(organization, project, environment, watchPrefill)}
              onClick={close}
            />
          ))}
      </PopoverContent>
    </Popover>
  );
}
