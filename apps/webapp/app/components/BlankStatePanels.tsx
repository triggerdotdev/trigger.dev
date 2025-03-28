import {
  BeakerIcon,
  BellAlertIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  PlusIcon,
  RectangleGroupIcon,
  RectangleStackIcon,
  ServerStackIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { useLocation } from "react-use";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type MinimumEnvironment } from "~/presenters/SelectBestEnvironmentPresenter.server";
import {
  docsPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3NewProjectAlertPath,
  v3NewSchedulePath,
} from "~/utils/pathBuilder";
import { InlineCode } from "./code/InlineCode";
import { environmentFullTitle } from "./environments/EnvironmentLabel";
import { Feedback } from "./Feedback";
import { EnvironmentSelector } from "./navigation/EnvironmentSelector";
import { Button, LinkButton } from "./primitives/Buttons";
import { Header1 } from "./primitives/Headers";
import { InfoPanel } from "./primitives/InfoPanel";
import { Paragraph } from "./primitives/Paragraph";
import { StepNumber } from "./primitives/StepNumber";
import { TextLink } from "./primitives/TextLink";
import { InitCommandV3, PackageManagerProvider, TriggerDevStepV3 } from "./SetupCommands";
import { StepContentContainer } from "./StepContentContainer";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";

export function HasNoTasksDev() {
  return (
    <PackageManagerProvider>
      <div>
        <div className="mb-6 flex items-center justify-between border-b">
          <Header1 spacing>Get setup in 3 minutes</Header1>
          <div className="flex items-center gap-2">
            <Feedback
              button={
                <Button variant="minimal/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                  I'm stuck!
                </Button>
              }
              defaultValue="help"
            />
          </div>
        </div>
        <StepNumber stepNumber="1" title="Run the CLI 'init' command in an existing project" />
        <StepContentContainer>
          <InitCommandV3 />
          <Paragraph spacing>
            You'll notice a new folder in your project called{" "}
            <InlineCode variant="small">trigger</InlineCode>. We've added a few simple example tasks
            in there to help you get started.
          </Paragraph>
        </StepContentContainer>
        <StepNumber stepNumber="2" title="Run the CLI 'dev' command" />
        <StepContentContainer>
          <TriggerDevStepV3 />
        </StepContentContainer>
        <StepNumber stepNumber="3" title="Waiting for tasks" displaySpinner />
        <StepContentContainer>
          <Paragraph>This page will automatically refresh.</Paragraph>
        </StepContentContainer>
      </div>
    </PackageManagerProvider>
  );
}

export function HasNoTasksDeployed({ environment }: { environment: MinimumEnvironment }) {
  return (
    <InfoPanel
      title={`You don't have any deployed tasks in ${environmentFullTitle(environment)}`}
      icon={TaskIcon}
      iconClassName="text-tasks"
      panelClassName="max-w-full"
      accessory={
        <LinkButton
          to={docsPath("deployment/overview")}
          variant="docs/small"
          LeadingIcon={BookOpenIcon}
        >
          How to deploy tasks
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Run the <TextLink to={docsPath("deployment/overview")}>CLI deploy command</TextLink> to
        deploy your tasks to the {environmentFullTitle(environment)} environment.
      </Paragraph>
    </InfoPanel>
  );
}

export function SchedulesNoPossibleTaskPanel() {
  return (
    <InfoPanel
      title="Create your first scheduled task"
      icon={ClockIcon}
      iconClassName="text-schedules"
      panelClassName="max-w-full"
      accessory={
        <LinkButton
          to={docsPath("v3/tasks-scheduled")}
          variant="docs/small"
          LeadingIcon={BookOpenIcon}
        >
          How to schedule tasks
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        You have no scheduled tasks in your project. Before you can schedule a task you need to
        create a <InlineCode>schedules.task</InlineCode>.
      </Paragraph>
    </InfoPanel>
  );
}

export function SchedulesNoneAttached() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();

  return (
    <InfoPanel
      title="Attach your first schedule"
      icon={ClockIcon}
      iconClassName="text-schedules"
      panelClassName="max-w-full"
    >
      <Paragraph spacing variant="small">
        Scheduled tasks will only run automatically if you connect a schedule to them, you can do
        this in the dashboard or using the SDK.
      </Paragraph>
      <div className="flex gap-2">
        <LinkButton
          to={`${v3NewSchedulePath(organization, project, environment)}${location.search}`}
          variant="secondary/medium"
          LeadingIcon={RectangleGroupIcon}
          className="inline-flex"
          leadingIconClassName="text-blue-500"
        >
          Use the dashboard
        </LinkButton>
        <LinkButton
          to={docsPath("v3/tasks-scheduled")}
          variant="docs/medium"
          LeadingIcon={BookOpenIcon}
          className="inline-flex"
        >
          Use the SDK
        </LinkButton>
      </div>
    </InfoPanel>
  );
}

export function BatchesNone() {
  return (
    <InfoPanel
      title="Triggering batches"
      icon={Squares2X2Icon}
      iconClassName="text-batches"
      panelClassName="max-w-full"
      accessory={
        <LinkButton to={docsPath("triggering")} variant="docs/small" LeadingIcon={BookOpenIcon}>
          How to trigger batches
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        You have no batches in this environment. You can trigger batches from your backend or from
        inside other tasks.
      </Paragraph>
    </InfoPanel>
  );
}

export function TestHasNoTasks() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return (
    <InfoPanel
      title="You don't have any tasks to test"
      icon={BeakerIcon}
      iconClassName="text-tests"
      panelClassName="max-w-full"
      accessory={
        <LinkButton
          to={v3EnvironmentPath(organization, project, environment)}
          variant="primary/small"
        >
          Create a task
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Before testing a task, you must first create one. Follow the instructions on the{" "}
        <TextLink to={v3EnvironmentPath(organization, project, environment)}>Tasks page</TextLink>{" "}
        to create a task, then return here to test it.
      </Paragraph>
    </InfoPanel>
  );
}

export function DeploymentsNone() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <InfoPanel
      icon={ServerStackIcon}
      iconClassName="text-deployments"
      title="Deploy for the first time"
      panelClassName="max-w-full"
    >
      <Paragraph spacing variant="small">
        There are several ways to deploy your tasks. You can use the CLI, Continuous Integration
        (like GitHub Actions), or an integration with a service like Netlify or Vercel. Make sure
        you{" "}
        <TextLink href={v3EnvironmentVariablesPath(organization, project, environment)}>
          set your environment variables
        </TextLink>{" "}
        first.
      </Paragraph>
      <div className="flex gap-3">
        <LinkButton
          to={docsPath("v3/cli-deploy")}
          variant="docs/medium"
          LeadingIcon={BookOpenIcon}
          className="inline-flex"
        >
          Deploy with the CLI
        </LinkButton>
        <LinkButton
          to={docsPath("v3/github-actions")}
          variant="docs/medium"
          LeadingIcon={BookOpenIcon}
          className="inline-flex"
        >
          Deploy with GitHub actions
        </LinkButton>
      </div>
    </InfoPanel>
  );
}

export function DeploymentsNoneDev() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="space-y-8">
      <InfoPanel
        icon={ServerStackIcon}
        iconClassName="text-deployments"
        title="Deploying tasks"
        panelClassName="max-w-full"
      >
        <Paragraph spacing variant="small">
          This is the Development environment. When you're ready to deploy your tasks, switch to a
          different environment.
        </Paragraph>
        <Paragraph spacing variant="small">
          There are several ways to deploy your tasks. You can use the CLI, Continuous Integration
          (like GitHub Actions), or an integration with a service like Netlify or Vercel. Make sure
          you{" "}
          <TextLink href={v3EnvironmentVariablesPath(organization, project, environment)}>
            set your environment variables
          </TextLink>{" "}
          first.
        </Paragraph>
        <div className="flex gap-3">
          <LinkButton
            to={docsPath("v3/cli-deploy")}
            variant="docs/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Deploy with the CLI
          </LinkButton>
          <LinkButton
            to={docsPath("v3/github-actions")}
            variant="docs/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Deploy with GitHub actions
          </LinkButton>
        </div>
      </InfoPanel>
      <SwitcherPanel />
    </div>
  );
}

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

export function QueuesHasNoTasks() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <InfoPanel
      title="You don't have any queues"
      icon={RectangleStackIcon}
      iconClassName="text-queues"
      panelClassName="max-w-md"
      accessory={
        <LinkButton
          to={v3EnvironmentPath(organization, project, environment)}
          variant="primary/small"
        >
          Create a task
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Queues will appear here when you have created a task in this environment. Follow the
        instructions on the{" "}
        <TextLink to={v3EnvironmentPath(organization, project, environment)}>Tasks page</TextLink>{" "}
        to create a task, then return here to see its queue.
      </Paragraph>
    </InfoPanel>
  );
}

export function NoWaitpointTokens() {
  return (
    <InfoPanel
      title="You don't have any waitpoint tokens"
      icon={WaitpointTokenIcon}
      iconClassName="text-sky-500"
      panelClassName="max-w-md"
      accessory={
        <LinkButton to={docsPath("wait")} variant="docs/small" LeadingIcon={BookOpenIcon}>
          Waitpoint docs
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Waitpoint tokens are used to pause runs until you complete the token so the run can
        continue.
      </Paragraph>
      <Paragraph spacing variant="small">
        You can build approval workflows using them, as well as other use cases.
      </Paragraph>
    </InfoPanel>
  );
}

function SwitcherPanel() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="flex items-center rounded-md border border-grid-bright bg-background-bright p-3">
      <Paragraph variant="small" className="grow">
        Switch to a deployed environment
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
