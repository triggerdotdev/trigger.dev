import { BellAlertIcon } from "@heroicons/react/20/solid";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { v3AlertCreatePath } from "~/utils/pathBuilder";

export function RunCreateAlertButton({
  taskIdentifier,
  organization,
  project,
  environment,
}: {
  taskIdentifier: string;
  organization: Parameters<typeof v3AlertCreatePath>[0];
  project: Parameters<typeof v3AlertCreatePath>[1];
  environment: Parameters<typeof v3AlertCreatePath>[2];
}) {
  const agent = useDashboardAgent();
  const prefill = {
    area: "runs" as const,
    scope: "task" as const,
    scopeValue: taskIdentifier,
  };

  return agent ? (
    <Button
      variant="secondary/small"
      LeadingIcon={BellAlertIcon}
      leadingIconClassName="text-alerts"
      tooltip="Create a new alert"
      onClick={() => agent.openCreateAlert(prefill)}
    >
      Watch
    </Button>
  ) : (
    <LinkButton
      to={v3AlertCreatePath(organization, project, environment, prefill)}
      variant="secondary/small"
      LeadingIcon={BellAlertIcon}
      leadingIconClassName="text-alerts"
      tooltip="Create a new alert"
    >
      Watch
    </LinkButton>
  );
}
