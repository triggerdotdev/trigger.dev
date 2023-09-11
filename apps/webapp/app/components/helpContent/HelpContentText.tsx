import { Link } from "@remix-run/react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { IntegrationIcon } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations/route";
import { jobTestPath } from "~/utils/pathBuilder";
import { CodeBlock } from "../code/CodeBlock";
import { InlineCode } from "../code/InlineCode";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { HelpPanelProps } from "../integrations/ApiKeyHelp";
import { HelpInstall } from "../integrations/HelpInstall";
import { HelpSamples } from "../integrations/HelpSamples";
import { LinkButton } from "../primitives/Buttons";
import { Callout, variantClasses } from "../primitives/Callout";
import { Header2 } from "../primitives/Headers";
import { TextLink } from "../primitives/TextLink";
import integrationButton from "./integration-button.png";
import selectEnvironment from "./select-environment.png";
import selectExample from "./select-example.png";
import { StepContentContainer } from "../StepContentContainer";
import { TriggerDevCommand } from "../SetupCommands";

export function HowToRunYourJob() {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  return (
    <>
      <Paragraph spacing>There are two ways to run your Job:</Paragraph>

      <StepNumber stepNumber="1" title="Trigger a test Run" />
      <StepContentContainer>
        <Paragraph spacing>
          You can perform a Run with any payload you want, or use one of our examples, on the test
          page.
        </Paragraph>
        <LinkButton
          to={jobTestPath(organization, project, job)}
          variant={"primary/small"}
          LeadingIcon={"beaker"}
          leadingIconClassName="text-bright"
        >
          Test
        </LinkButton>
      </StepContentContainer>

      <StepNumber stepNumber="2" title="Trigger your Job for real" />
      <StepContentContainer>
        <Paragraph spacing>
          Performing a real run depends on the type of Trigger your Job is using.
        </Paragraph>

        <LinkButton
          to="https://trigger.dev/docs/documentation/guides/running-jobs"
          variant={"primary/small"}
          LeadingIcon={"docs"}
          leadingIconClassName="text-bright"
        >
          How to run a Job
        </LinkButton>
      </StepContentContainer>
      <Callout variant="info">
        <Paragraph variant={"small"} className={variantClasses.info.textColor}>
          Scheduled Triggers <strong>do not</strong> trigger Jobs in the DEV Environment. When
          developing locally you should use the{" "}
          <Link
            to={jobTestPath(organization, project, job)}
            className="underline underline-offset-2 transition hover:text-blue-100"
          >
            Test feature
          </Link>{" "}
          to trigger any scheduled Jobs.
        </Paragraph>
      </Callout>
    </>
  );
}

export function HowToRunATest() {
  return (
    <>
      <StepNumber
        stepNumber="1"
        title="Select an environment
"
      />
      <StepContentContainer>
        <Paragraph spacing>Select the environment you’d like the test to run against.</Paragraph>
        <img src={selectEnvironment} className="mt-2 w-52" />
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Write your test payload" />
      <StepContentContainer>
        <Paragraph spacing>
          Write your own payload specific to your Job. Some Triggers also provide example payloads
          that you can select from. This will populate the code editor below.
        </Paragraph>
        <img src={selectExample} className="mt-2 h-40" />
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Run your test" />
      <StepContentContainer>
        <Paragraph spacing>When you’re happy with the payload, click Run test.</Paragraph>
      </StepContentContainer>
      <Callout variant="docs" to="https://trigger.dev/docs/documentation/guides/testing-jobs">
        Learn more about running tests.
      </Callout>
    </>
  );
}

export function HowToConnectAnIntegration() {
  return (
    <>
      <StepNumber stepNumber="1" title="Select an API from the list" />
      <StepContentContainer>
        <Paragraph>
          APIs marked with a
          <span className="mx-2 -mt-1 inline-flex" aria-label="Trigger.dev Integration icon">
            <IntegrationIcon />
          </span>
          are Trigger.dev Integrations. These Integrations make connecting to the API easier by
          offering OAuth or API key authentication. All APIs can also be used with fetch or an SDK.
        </Paragraph>
        <img src={integrationButton} className="mt-2 h-10" />
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Choose how you want to connect" />
      <StepContentContainer>
        <Paragraph>
          Follow the instructions for your chosen connection method in the popover form. If no
          Integration exists yet, you can request one by clicking the "I want an Integration"
          button.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Your connection will appear in the list" />
      <StepContentContainer>
        <Paragraph>
          Once you've connected your API, it will appear in the list of Integrations below. You can
          view details and manage your connection by selecting it from the table.
        </Paragraph>
      </StepContentContainer>
      <Callout variant={"docs"} to="https://trigger.dev/docs/integrations/introduction">
        View the Integration docs page for more information on connecting an API using an
        Integration or other method.
      </Callout>
    </>
  );
}

export function HowToUseThisIntegration({ integration, help, integrationClient }: HelpPanelProps) {
  return (
    <>
      <StepNumber stepNumber="1" title="Install the package" />
      <StepContentContainer>
        <HelpInstall packageName={integration.packageName} />
      </StepContentContainer>
      {help && (
        <>
          <StepNumber stepNumber="2" title="Create a Job" />
          <StepContentContainer>
            <HelpSamples
              help={help}
              integration={integration}
              integrationClient={integrationClient}
            />
          </StepContentContainer>
        </>
      )}
    </>
  );
}

export function HowToDisableAJob({
  id,
  name,
  version,
}: {
  id: string;
  name: string;
  version: string;
}) {
  return (
    <>
      <Paragraph spacing>
        To disable a job, you need to set the <InlineCode>enabled</InlineCode> property to{" "}
        <InlineCode>false</InlineCode>.
      </Paragraph>
      <StepNumber
        stepNumber="1"
        title={
          <>
            Set <InlineCode>enabled</InlineCode> to <InlineCode>false</InlineCode>
          </>
        }
      />
      <StepContentContainer>
        <CodeBlock
          showLineNumbers={false}
          className="mb-4"
          code={`client.defineJob({
  id: "${id}",
  name: "${name}",
  version: "${version}",
  enabled: false,
  // ...rest of your Job definition
});`}
        />
      </StepContentContainer>
      <StepNumber
        stepNumber="2"
        title={
          <>
            Run the <InlineCode>@trigger.dev/cli dev</InlineCode> command
          </>
        }
      />
      <StepContentContainer>
        <Paragraph spacing>
          If you aren't already running the <InlineCode>dev</InlineCode> command, run it now.
        </Paragraph>
        <TriggerDevCommand />
      </StepContentContainer>
    </>
  );
}

export function HowToUseApiKeysAndEndpoints() {
  return (
    <>
      <Paragraph spacing>
        Environments and Endpoints are used to connect your server to the Trigger.dev platform.
      </Paragraph>
      <Header2 spacing>Environments</Header2>
      <Paragraph spacing>
        Each environment has API Keys associated with it. The Server API Key is used to authenticate
        your Jobs with the Trigger.dev platform.
      </Paragraph>
      <Paragraph spacing>
        The Server API Key you use for your{" "}
        <TextLink to="https://trigger.dev/docs/documentation/concepts/client-adaptors">
          Client
        </TextLink>{" "}
        is how we know which environment to run your code against:
      </Paragraph>
      <CodeBlock
        showLineNumbers={false}
        className="mb-4"
        code={`export const client = new TriggerClient({
  id: "nextjs-example",
  //this environment variable should be set to your Server DEV API Key locally,
  //and your Server PROD API Key in production
  apiKey: process.env.TRIGGER_API_KEY!,
});`}
      />
      <StepNumber
        stepNumber="→"
        title={
          <span className="flex items-center gap-x-2">
            <span>Development</span>
            <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />
          </span>
        }
      />
      <StepContentContainer>
        <Paragraph>
          The <InlineCode>DEV</InlineCode> environment should only be used for local development.
          It’s where you can test your Jobs before deploying them to servers.
        </Paragraph>
        <Callout variant="warning" className="my-2">
          Scheduled Triggers do not trigger Jobs in the DEV Environment. When you’re working locally
          you should use the Test feature to trigger any scheduled Jobs.
        </Callout>
      </StepContentContainer>
      <StepNumber
        stepNumber="→"
        title={
          <span className="flex items-center gap-x-2">
            <span>Production</span>
            <EnvironmentLabel environment={{ type: "PRODUCTION" }} />
          </span>
        }
      />
      <StepContentContainer>
        <Paragraph spacing>
          The <InlineCode>PROD</InlineCode> environment is where your Jobs will run in production.
          It’s where you can run your Jobs against real data.
        </Paragraph>
      </StepContentContainer>
      <Header2 spacing>Endpoints</Header2>
      <Paragraph spacing>
        An Endpoint is a URL on your server that Trigger.dev can connect to. This URL is used to
        register Jobs, start them and orchestrate runs and retries.
      </Paragraph>
      <Paragraph spacing>
        <InlineCode>DEV</InlineCode> has multiple endpoints associated with it – one for each team
        member. This allows each team member to run their own Jobs, without interfering with each
        other.
      </Paragraph>
      <Paragraph spacing>
        All other environments have just a single endpoint (with a single URL) associated with them.
      </Paragraph>
      <Header2 spacing>Deployment</Header2>
      <Paragraph spacing>
        Deployment uses Environments and Endpoints to connect your Jobs to the Trigger.dev platform.
      </Paragraph>
      <Callout variant="docs" to="https://trigger.dev/docs/documentation/guides/deployment">
        Read the deployment guide to learn more.
      </Callout>
    </>
  );
}
