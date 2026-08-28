import {
  BeakerIcon,
  BellAlertIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import openBulkActionsPanel from "~/assets/images/open-bulk-actions-panel.png";
import selectRunsIndividually from "~/assets/images/select-runs-individually.png";
import selectRunsUsingFilters from "~/assets/images/select-runs-using-filters.png";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type MinimumEnvironment } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { type BranchableEnvironmentToken } from "~/utils/branchableEnvironment";
import { NewBranchPanel } from "~/routes/resources.branches.create";
import { GitHubSettingsPanel } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";
import {
  docsPath,
  v3BillingPath,
  v3CreateBulkActionPath,
  v3EnvironmentPath,
  v3NewProjectAlertPath,
} from "~/utils/pathBuilder";
import { AskAgentButton } from "./dashboard-agent/AskAgentButton";
import { CodeBlock } from "./code/CodeBlock";
import { useDevPresence } from "./DevPresence";
import { InlineCode } from "./code/InlineCode";
import { environmentFullTitle, EnvironmentIcon } from "./environments/EnvironmentLabel";
import { Feedback } from "./Feedback";
import { EnvironmentSelector } from "./navigation/EnvironmentSelector";
import { Button, LinkButton } from "./primitives/Buttons";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "./primitives/ClientTabs";
import { Header1 } from "./primitives/Headers";
import { InfoPanel } from "./primitives/InfoPanel";
import { Paragraph } from "./primitives/Paragraph";
import { StepNumber } from "./primitives/StepNumber";
import { TextLink } from "./primitives/TextLink";
import { SimpleTooltip } from "./primitives/Tooltip";
import {
  InitAgentPromptV3,
  InitCommandV3,
  PackageManagerProvider,
  TriggerDeployStep,
  TriggerDevStepV3,
} from "./SetupCommands";
import { StepContentContainer } from "./StepContentContainer";

/**
 * What the agent is asked when it's opened from a deployment setup panel. The panel is the docs
 * answer; the agent is for the part the docs can't answer — this project, this environment.
 */
const ASK_AGENT_DEPLOY_PROMPT =
  "I'm trying to deploy my tasks to this environment. Walk me through it and tell me if anything about this project or environment is going to get in the way.";

/** The docs links the deployment panels offer to anyone without the agent. */
function DeployDocsLinks() {
  return (
    <>
      <SimpleTooltip
        asChild
        tabbable
        button={
          // Span wrapper: LinkButton drops the pointer-event props Radix injects via asChild, so
          // the tooltip trigger has to be a plain element (same pattern as FavoritePageButton).
          <span className="flex">
            <LinkButton
              variant="small-menu-item"
              LeadingIcon={BookOpenIcon}
              leadingIconClassName="text-blue-500"
              to={docsPath("deployment/overview")}
              aria-label="Deploy docs"
            />
          </span>
        }
        content="Deploy docs"
      />
      <SimpleTooltip
        asChild
        tabbable
        button={
          <span className="flex">
            <LinkButton
              variant="small-menu-item"
              LeadingIcon={QuestionMarkCircleIcon}
              leadingIconClassName="text-blue-500"
              to={docsPath("troubleshooting#deployment")}
              aria-label="Troubleshooting docs"
            />
          </span>
        }
        content="Troubleshooting docs"
      />
    </>
  );
}

export function HasNoTasksDev({ initializedAt }: { initializedAt: Date | string | null }) {
  const { isConnected } = useDevPresence();
  const initialized = !!initializedAt;
  const devConnected = isConnected === true;

  return (
    <PackageManagerProvider>
      <div>
        <div className="mb-6 flex items-center justify-between border-b">
          <Header1 spacing>Get set up in 2 minutes</Header1>
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
        {!initialized && (
          <>
            <div className="flex flex-col gap-4 rounded-md border border-indigo-400/20 bg-indigo-800/10 p-4 sm:flex-row sm:items-center">
              <span className="flex size-9 shrink-0 items-center justify-center self-start rounded-md bg-indigo-500/15 text-indigo-400">
                <AISparkleIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <Paragraph className="text-text-bright">Set it up with your AI agent</Paragraph>
                <Paragraph variant="small" className="text-text-dimmed">
                  Copy a ready-to-paste prompt for Claude Code, Cursor, or any coding agent. It
                  includes your project reference.
                </Paragraph>
              </div>
              <div className="shrink-0 sm:ml-4">
                <InitAgentPromptV3 />
              </div>
            </div>
            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-grid-bright" />
              <span className="text-xs uppercase tracking-wide text-text-dimmed">
                or set it up yourself
              </span>
              <div className="h-px flex-1 bg-grid-bright" />
            </div>
          </>
        )}
        <StepNumber
          stepNumber="1"
          title={initialized ? "Project initialized" : "Initialize your project"}
          complete={initialized}
        />
        <StepContentContainer>
          {initialized ? (
            <Paragraph>
              Your project is initialized. Your tasks live in the{" "}
              <InlineCode variant="small">trigger</InlineCode> directory.
            </Paragraph>
          ) : (
            <>
              <InitCommandV3 />
              <Paragraph spacing>
                Run this in an existing project. You'll notice a new folder called{" "}
                <InlineCode variant="small">trigger</InlineCode> with a few example tasks to help
                you get started.
              </Paragraph>
            </>
          )}
        </StepContentContainer>
        <StepNumber
          stepNumber="2"
          title={devConnected ? "Dev server connected" : "Start the dev server"}
          complete={devConnected}
        />
        <StepContentContainer>
          {devConnected ? (
            <Paragraph>
              Your dev server is connected. Your tasks will appear here automatically as soon as
              they register.
            </Paragraph>
          ) : (
            <>
              <TriggerDevStepV3 />
              <Paragraph spacing>
                Keep this running while you develop. Once your tasks register, this page updates
                automatically.
              </Paragraph>
            </>
          )}
        </StepContentContainer>
      </div>
    </PackageManagerProvider>
  );
}

export function HasNoTasksDeployed({ environment }: { environment: MinimumEnvironment }) {
  return <DeploymentOnboardingSteps />;
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

export function SessionsNone() {
  return (
    <InfoPanel
      title="Sessions"
      icon={AIChatIcon}
      iconClassName="text-sessions"
      panelClassName="max-w-full"
      accessory={
        <LinkButton
          to={docsPath("ai-chat/sessions")}
          variant="docs/small"
          LeadingIcon={BookOpenIcon}
        >
          Sessions docs
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        A session is a stateful execution of an agent, with two-way streaming and durable compute. A
        single session can have multiple runs associated with it, so one conversation can span many
        task triggers. The input stream carries incoming user messages, and the output stream
        carries everything the agent produces, including AI generation parts (text, reasoning, tool
        calls, etc.) and any custom data parts your task emits.
      </Paragraph>
      <Paragraph spacing variant="small">
        The easiest way to create one is to trigger a <InlineCode>chat.agent</InlineCode> task,
        which is built on sessions and handles the chat turn loop for you. You can also call{" "}
        <InlineCode>sessions.start()</InlineCode> directly for non-chat patterns like agent inboxes,
        approval flows, or server-to-server streaming.
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
  return <DeploymentOnboardingSteps />;
}

export function DeploymentsNoneDev() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <>
      <div className="mb-6 flex items-center justify-between border-b">
        <div className="mb-2 flex items-center gap-2">
          <EnvironmentIcon environment={environment} className="-ml-1 size-8" />
          <Header1>Deploy your tasks</Header1>
        </div>
        <div className="flex items-center">
          {/* One entry point instead of two: the docs links were a guess at which page you
              needed, and the agent can look at this project and answer for it. Someone with no
              agent still gets the links. */}
          <AskAgentButton prompt={ASK_AGENT_DEPLOY_PROMPT} fallback={<DeployDocsLinks />} />
        </div>
      </div>
      <StepNumber stepNumber="→" title="Switch to a deployed environment" />
      <StepContentContainer className="mb-4 flex flex-col gap-4">
        <Paragraph>
          This is the Development environment. When you're ready to deploy your tasks, switch to a
          different environment.
        </Paragraph>
        <EnvironmentSelector
          organization={organization}
          project={project}
          environment={environment}
          className="w-fit border border-border-bright bg-secondary hover:border-border-brighter hover:bg-surface-control"
        />
      </StepContentContainer>
    </>
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

export function NoWaitpointTokens() {
  return (
    <InfoPanel
      title="You don't have any waitpoint tokens"
      icon={WaitpointTokenIcon}
      iconClassName="text-sky-500"
      panelClassName="max-w-md"
      accessory={
        <LinkButton to={docsPath("wait-for-token")} variant="docs/small" LeadingIcon={BookOpenIcon}>
          Waitpoint docs
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Waitpoint tokens pause task runs until you complete the token. They're commonly used for
        approval workflows and other scenarios where you need to wait for external confirmation,
        such as human-in-the-loop processes.
      </Paragraph>
    </InfoPanel>
  );
}

export function BranchesNoBranchableEnvironment({ showSelfServe }: { showSelfServe: boolean }) {
  const { isManagedCloud } = useFeatures();
  const organization = useOrganization();

  if (!isManagedCloud) {
    return (
      <InfoPanel
        title="Create a preview environment"
        icon={BranchEnvironmentIconSmall}
        iconClassName="text-preview"
        panelClassName="max-w-full"
      >
        <Paragraph spacing variant="small">
          To add branches you need to have a <InlineCode>RuntimeEnvironment</InlineCode> where{" "}
          <InlineCode>isBranchableEnvironment</InlineCode> is true. We recommend creating a
          dedicated one using the "PREVIEW" type.
        </Paragraph>
      </InfoPanel>
    );
  }

  return (
    <InfoPanel
      title="Upgrade to get preview branches"
      icon={BranchEnvironmentIconSmall}
      iconClassName="text-preview"
      panelClassName="max-w-full"
      accessory={
        showSelfServe ? (
          <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
            Upgrade
          </LinkButton>
        ) : (
          <Feedback
            button={<Button variant="secondary/small">Request more</Button>}
            defaultValue="enterprise"
          />
        )
      }
    >
      <Paragraph variant="small">
        Preview branches in Trigger.dev create isolated environments for testing new features before
        production.
      </Paragraph>
    </InfoPanel>
  );
}

export function BranchesNoBranches({
  env,
  limits,
  canUpgrade,
  showSelfServe,
}: {
  env: BranchableEnvironmentToken;
  limits: { used: number; limit: number };
  canUpgrade: boolean;
  showSelfServe: boolean;
}) {
  const organization = useOrganization();

  const envTextClassName = env === "preview" ? "text-preview" : "text-dev";
  const branchesLabel = env === "preview" ? "preview branches" : "dev branches";

  if (limits.used >= limits.limit) {
    return (
      <InfoPanel
        title={`Upgrade to get ${branchesLabel}`}
        icon={BranchEnvironmentIconSmall}
        iconClassName={envTextClassName}
        panelClassName="max-w-full"
        accessory={
          showSelfServe && canUpgrade ? (
            <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
              Upgrade
            </LinkButton>
          ) : (
            <Feedback
              button={
                <Button variant={showSelfServe ? "primary/small" : "secondary/small"}>
                  Request more
                </Button>
              }
              defaultValue={showSelfServe ? "help" : "enterprise"}
            />
          )
        }
      >
        <Paragraph spacing variant="small">
          You've reached the limit ({limits.used}/{limits.limit}) of branches for your plan. Upgrade
          to get branches.
        </Paragraph>
      </InfoPanel>
    );
  }

  return (
    <InfoPanel
      title="Create your first branch"
      icon={BranchEnvironmentIconSmall}
      iconClassName={envTextClassName}
      panelClassName="max-w-full"
      accessory={
        <NewBranchPanel
          button={
            <Button
              variant="primary/small"
              LeadingIcon={PlusIcon}
              leadingIconClassName="text-white"
            >
              New branch
            </Button>
          }
          env={env}
        />
      }
    >
      <Paragraph variant="small">
        Branches are a way to test new features in isolation before merging them into the main
        environment.
      </Paragraph>
    </InfoPanel>
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

export function BulkActionsNone() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between border-b pb-0.5">
        <Header1 spacing>Create a bulk action</Header1>
        <div className="flex items-center gap-2">
          <LinkButton
            variant="primary/small"
            LeadingIcon={PlusIcon}
            to={v3CreateBulkActionPath(organization, project, environment)}
          >
            New bulk action
          </LinkButton>
        </div>
      </div>
      <StepNumber stepNumber="1" title="Select runs individually" />
      <StepContentContainer className="mb-4 flex flex-col gap-4">
        <Paragraph>Select runs from the runs page individually.</Paragraph>
        <div>
          <img src={selectRunsIndividually} alt="Select runs individually" />
        </div>
      </StepContentContainer>
      <div className="mb-5 ml-9 flex items-center gap-2">
        <div className="h-px w-full bg-grid-bright" />
        <Paragraph variant="extra-small" className="text-text-dimmed">
          OR
        </Paragraph>
        <div className="h-px w-full bg-grid-bright" />
      </div>
      <StepNumber stepNumber="2" title="Select runs using filters" />
      <StepContentContainer className="flex flex-col gap-4">
        <Paragraph>
          Use the filter menu on the runs page to select just the runs you want to bulk action.
        </Paragraph>
        <div>
          <img src={selectRunsUsingFilters} alt="Select runs using filters" />
        </div>
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Open the bulk action panel" />
      <StepContentContainer className="flex flex-col gap-4">
        <Paragraph>Click the “Bulk actions” button in the top right of the runs page.</Paragraph>
        <div>
          <img src={openBulkActionsPanel} alt="Open the bulk action panel" />
        </div>
      </StepContentContainer>
    </div>
  );
}

function DeploymentOnboardingSteps() {
  const environment = useEnvironment();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PackageManagerProvider>
      <div className="mb-2 flex items-center justify-between border-b">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <EnvironmentIcon environment={environment} className="-ml-1 size-8 shrink-0" />
          <Header1 className="truncate">
            Deploy your tasks to {environmentFullTitle(environment)}
          </Header1>
        </div>
        <div className="flex items-center">
          {/* One entry point instead of two: the docs links were a guess at which page you
              needed, and the agent can look at this project and answer for it. Someone with no
              agent still gets the links. */}
          <AskAgentButton prompt={ASK_AGENT_DEPLOY_PROMPT} fallback={<DeployDocsLinks />} />
        </div>
      </div>
      <ClientTabs defaultValue="github">
        <ClientTabsList variant="segmented" className="mb-6">
          <ClientTabsTrigger value={"github"} variant="segmented" layoutId="deploy-tabs">
            GitHub
          </ClientTabsTrigger>
          <ClientTabsTrigger value={"cli"} variant="segmented" layoutId="deploy-tabs">
            Manual
          </ClientTabsTrigger>
          <ClientTabsTrigger value={"github-actions"} variant="segmented" layoutId="deploy-tabs">
            GitHub Actions
          </ClientTabsTrigger>
        </ClientTabsList>
        <ClientTabsContent value={"github"}>
          <StepNumber stepNumber="1" title="Connect your GitHub repository" />
          <StepContentContainer>
            <Paragraph spacing>
              Deploy automatically with every push. Read the{" "}
              <TextLink to={docsPath("github-integration")}>full guide</TextLink>.
            </Paragraph>
            <GitHubSettingsPanel
              organizationSlug={organization.slug}
              projectSlug={project.slug}
              environmentSlug={environment.slug}
              billingPath={v3BillingPath({ slug: organization.slug })}
            />
          </StepContentContainer>
        </ClientTabsContent>
        <ClientTabsContent value={"cli"}>
          <StepNumber stepNumber="1" title="Run the CLI 'deploy' command" />
          <StepContentContainer>
            <Paragraph spacing>
              This will deploy your tasks to the {environmentFullTitle(environment)} environment.
              Read the <TextLink to={docsPath("deployment/overview")}>full guide</TextLink>.
            </Paragraph>
            <TriggerDeployStep environment={environment} />
          </StepContentContainer>
        </ClientTabsContent>
        <ClientTabsContent value={"github-actions"}>
          <StepNumber stepNumber="1" title="Deploy using GitHub Actions" />
          <StepContentContainer>
            <Paragraph spacing>
              Read the <TextLink to={docsPath("github-actions")}>GitHub Actions guide</TextLink> to
              get started.
            </Paragraph>
          </StepContentContainer>
        </ClientTabsContent>
      </ClientTabs>

      <StepNumber stepNumber="2" title="Waiting for tasks to deploy" displaySpinner />
      <StepContentContainer>
        <Paragraph>This page will automatically refresh when your tasks are deployed.</Paragraph>
      </StepContentContainer>
    </PackageManagerProvider>
  );
}

export function PromptsNone() {
  return (
    <InfoPanel
      title="Define your first prompt"
      icon={AIPenIcon}
      iconClassName="text-aiPrompts"
      panelClassName="max-w-lg"
      accessory={
        <LinkButton to={docsPath("ai/prompts")} variant="docs/small" LeadingIcon={BookOpenIcon}>
          Prompts docs
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Managed prompts let you define AI prompts in code with typesafe variables, then edit and
        version them from the dashboard without redeploying.
      </Paragraph>
      <Paragraph spacing variant="small">
        Add a prompt to your project using <InlineCode variant="small">prompts.define()</InlineCode>
        :
      </Paragraph>
      <CodeBlock
        code={`import { prompts } from "@trigger.dev/sdk";
import { z } from "zod";

export const myPrompt = prompts.define({
  id: "my-prompt",
  variables: z.object({
    name: z.string(),
  }),
  content: \`Hello {{name}}!\`,
});`}
        showLineNumbers={false}
        showOpenInModal={false}
      />
      <Paragraph variant="small" className="mt-2">
        Deploy your project and your prompts will appear here with version history and a live
        editor.
      </Paragraph>
    </InfoPanel>
  );
}
