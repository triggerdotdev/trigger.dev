import { BellAlertIcon, BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { EnvironmentSelector } from "~/components/navigation/EnvironmentSelector";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { docsPath, v3NewProjectAlertPath } from "~/utils/pathBuilder";

export function AlertsNoneDev() {
  return (
    <div className="space-y-8">
      <InfoPanel
        icon={BellAlertIcon}
        iconClassName="text-alerts"
        title="Adding alerts"
        panelClassName="max-w-full"
      >
        <Paragraph spacing variant="small">
          You can get alerted when deployed runs fail.
        </Paragraph>
        <Paragraph spacing variant="small">
          We don't support alerts in the Development environment. Switch to a deployed environment
          to setup alerts.
        </Paragraph>
        <div className="flex gap-3">
          <LinkButton
            to={docsPath("troubleshooting-alerts")}
            variant="docs/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            How to setup alerts
          </LinkButton>
        </div>
      </InfoPanel>
      <SwitcherPanel />
    </div>
  );
}

export function AlertsNoneDeployed() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="space-y-8">
      <InfoPanel
        icon={BellAlertIcon}
        iconClassName="text-alerts"
        title="Adding alerts"
        panelClassName="max-w-full"
      >
        <Paragraph spacing variant="small">
          You can get alerted when deployed runs fail. We currently support sending Slack, Email,
          and webhooks.
        </Paragraph>

        <div className="flex items-center justify-between gap-3">
          <LinkButton
            to={docsPath("troubleshooting-alerts")}
            variant="docs/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Alerts docs
          </LinkButton>
          <LinkButton
            to={v3NewProjectAlertPath(organization, project, environment)}
            variant="primary/medium"
            LeadingIcon={PlusIcon}
            shortcut={{ key: "n" }}
          >
            New alert
          </LinkButton>
        </div>
      </InfoPanel>
    </div>
  );
}

function SwitcherPanel({ title = "Switch to a deployed environment" }: { title?: string }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="flex items-center rounded-md border border-grid-bright bg-background-bright p-3">
      <Paragraph variant="small" className="grow">
        {title}
      </Paragraph>
      <EnvironmentSelector
        organization={organization}
        project={project}
        environment={environment}
        className="w-auto grow-0 rounded-sm bg-grid-bright"
      />
    </div>
  );
}
