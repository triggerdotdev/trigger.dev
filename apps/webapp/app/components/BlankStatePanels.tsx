import {
  BeakerIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  RectangleGroupIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { type MinimumEnvironment } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { docsPath, v3EnvironmentPath, v3NewSchedulePath } from "~/utils/pathBuilder";
import { InlineCode } from "./code/InlineCode";
import { environmentFullTitle } from "./environments/EnvironmentLabel";
import { Feedback } from "./Feedback";
import { Button, LinkButton } from "./primitives/Buttons";
import { Header1 } from "./primitives/Headers";
import { InfoPanel } from "./primitives/InfoPanel";
import { Paragraph } from "./primitives/Paragraph";
import { StepNumber } from "./primitives/StepNumber";
import { InitCommandV3, PackageManagerProvider, TriggerDevStepV3 } from "./SetupCommands";
import { StepContentContainer } from "./StepContentContainer";
import { useLocation } from "react-use";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RuntimeEnvironmentType } from "@trigger.dev/database";

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
            <InlineCode variant="small">trigger</InlineCode>. We've added a very simple example task
            in here to help you get started.
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
      title="You don't have any deployed tasks"
      icon={TaskIcon}
      iconClassName="text-blue-500"
    >
      <Paragraph spacing variant="small">
        You don't have any deployed tasks in {environmentFullTitle(environment)}.
      </Paragraph>
      <LinkButton
        to={docsPath("deployment/overview")}
        variant="docs/medium"
        LeadingIcon={BookOpenIcon}
      >
        How to deploy tasks
      </LinkButton>
    </InfoPanel>
  );
}

export function SchedulesNoPossibleTaskPanel() {
  return (
    <InfoPanel
      title="Create your first scheduled task"
      icon={ClockIcon}
      iconClassName="text-sun-500"
      panelClassName="max-w-full"
    >
      <Paragraph spacing variant="small">
        You have no scheduled tasks in your project. Before you can schedule a task you need to
        create a <InlineCode>schedules.task</InlineCode>.
      </Paragraph>
      <LinkButton
        to={docsPath("v3/tasks-scheduled")}
        variant="docs/medium"
        LeadingIcon={BookOpenIcon}
      >
        View the docs
      </LinkButton>
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
      iconClassName="text-sun-500"
      panelClassName="max-w-full"
    >
      <Paragraph spacing variant="small">
        Scheduled tasks will only run automatically if you connect a schedule to them, you can do
        this in the dashboard or using the SDK.
      </Paragraph>
      <div className="flex gap-2">
        <LinkButton
          to={`${v3NewSchedulePath(organization, project, environment)}${location.search}`}
          variant="primary/small"
          LeadingIcon={RectangleGroupIcon}
          className="inline-flex"
        >
          Use the dashboard
        </LinkButton>
        <LinkButton
          to={docsPath("v3/tasks-scheduled")}
          variant="primary/small"
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
      iconClassName="text-blue-500"
      panelClassName="max-w-full"
    >
      <Paragraph spacing variant="small">
        You have no batches in this environment. You can trigger batches from your backend or from
        inside other tasks.
      </Paragraph>
      <LinkButton to={docsPath("triggering")} variant="docs/medium" LeadingIcon={BookOpenIcon}>
        How to trigger batches
      </LinkButton>
    </InfoPanel>
  );
}

export function TestHasNoTasks() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <InfoPanel
      title="No tasks to test"
      icon={BeakerIcon}
      iconClassName="text-lime-500"
      panelClassName="max-w-full"
    >
      <Paragraph spacing variant="small">
        You have no tasks in this environment.
      </Paragraph>
      <LinkButton
        to={v3EnvironmentPath(organization, project, environment)}
        variant="tertiary/medium"
      >
        Add tasks
      </LinkButton>
    </InfoPanel>
  );
}
