import { BookOpenIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { IntegrationIcon } from "~/assets/icons/IntegrationIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { docsPath, jobTestPath } from "~/utils/pathBuilder";
import { CodeBlock } from "../code/CodeBlock";
import { InlineCode } from "../code/InlineCode";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { type HelpPanelProps } from "../integrations/ApiKeyHelp";
import { HelpInstall } from "../integrations/HelpInstall";
import { HelpSamples } from "../integrations/HelpSamples";
import { LinkButton } from "../primitives/Buttons";
import { Callout, variantClasses } from "../primitives/Callout";
import { Header2 } from "../primitives/Headers";
import { TextLink } from "../primitives/TextLink";
import { TriggerDevCommand } from "../SetupCommands";
import { StepContentContainer } from "../StepContentContainer";
import integrationButton from "./integration-button.png";

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
          leadingIconClassName="text-text-bright"
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
          variant={"tertiary/small"}
          LeadingIcon={BookOpenIcon}
          leadingIconClassName="text-text-bright"
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
            <span>Staging</span>
            <EnvironmentLabel environment={{ type: "STAGING" }} />
          </span>
        }
      />
      <StepContentContainer>
        <Paragraph spacing>
          The <InlineCode>STAGING</InlineCode> environment is where your Jobs will run in a staging
          environment, meant to mirror your production environment.
        </Paragraph>
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

export function WhatAreHttpEndpoints() {
  return (
    <>
      <Paragraph spacing>
        HTTP endpoints allow you to trigger your Jobs from any webhooks. They require a bit more
        work than using <TextLink to={docsPath("integrations/introduction")}>Integrations</TextLink>{" "}
        but allow you to connect to any API.
      </Paragraph>
      <Header2 spacing>Getting started</Header2>
      <Paragraph spacing>
        You need to define the HTTP endpoint in your code. To do this you use{" "}
        <InlineCode>client.defineHttpEndpoint()</InlineCode>. This will create an HTTP endpoint.
      </Paragraph>
      <Paragraph spacing>
        Then you can create a Trigger from this by calling <InlineCode>.onRequest()</InlineCode> on
        the created HTTP endpoint.
      </Paragraph>
      <Callout variant="docs" to={docsPath("documentation/concepts/http-endpoints")}>
        Read the HTTP endpoints guide to learn more.
      </Callout>
      <Header2 spacing className="mt-4">
        An example: cal.com
      </Header2>
      <CodeBlock
        code={`//create an HTTP endpoint
const caldotcom = client.defineHttpEndpoint({
  id: "cal.com",
  source: "cal.com",
  icon: "caldotcom",
  verify: async (request) => {
    //this helper function makes verifying most webhooks easy
    return await verifyRequestSignature({
      request,
      headerName: "X-Cal-Signature-256",
      secret: process.env.CALDOTCOM_SECRET!,
      algorithm: "sha256",
    });
  },
});

client.defineJob({
  id: "http-caldotcom",
  name: "HTTP Cal.com",
  version: "1.0.0",
  enabled: true,
  //create a Trigger from the HTTP endpoint above. The filter is optional.
  trigger: caldotcom.onRequest({ filter: { body: { triggerEvent: ["BOOKING_CANCELLED"] } } }),
  run: async (request, io, ctx) => {
    //note that when using HTTP endpoints, the first parameter is the request
    //you need to get the body, usually it will be json so you do:
    const body = await request.json();
    await io.logger.info("Body", body);
  },
});`}
      />
    </>
  );
}

export function HowToConnectHttpEndpoint() {
  return (
    <>
      <Header2 spacing>Setting up your webhook</Header2>
      <Paragraph spacing>
        To start receiving data you need to enter the Endpoint URL and secret into the API service
        you want to receive webhooks from.
      </Paragraph>

      <StepNumber stepNumber="1" title={<>Go to the relevant API dashboard</>} />
      <StepContentContainer>
        <Paragraph spacing>
          For example, if you want to receive webhooks from Cal.com then you should login to your
          Cal.com account and go to their Settings/Developer/Webhooks page.
        </Paragraph>
      </StepContentContainer>

      <StepNumber stepNumber="2" title={<>Copy the Webhook URL and Secret</>} />
      <StepContentContainer>
        <Paragraph spacing>
          A unique Webhook URL is created for each environment (Dev, Staging, and Prod). Jobs will
          only be triggered from the relevant environment.
        </Paragraph>
        <Paragraph spacing>
          Copy the relevant Endpoint URL and secret from the table opposite and paste it into the
          correct place in the API dashboard you located in the previous step.
        </Paragraph>
      </StepContentContainer>

      <StepNumber stepNumber="3" title={<>Add the Secret to your Environment variables</>} />
      <StepContentContainer>
        <Paragraph spacing>
          You should also add the Secret to the Environment variables in your code and where you're
          deploying. Usually in Node this means adding it to the .env file.
        </Paragraph>
        <Paragraph spacing>
          Use the secret in the <InlineCode>verify()</InlineCode> function of HTTP Endpoint. This
          ensures that someone can't just send a request to your Endpoint and trigger a Job.
          Different APIs do this verification in different ways – a common way is to have a header
          that has a hash of the payload and secret. Refer to the API's documentation for more
          information.
        </Paragraph>
      </StepContentContainer>

      <Header2 spacing>Triggering runs</Header2>
      <StepNumber stepNumber="1" title="Ensure you're using the HTTP Endpoint in your code" />
      <StepContentContainer>
        <Paragraph spacing>
          In your code, you should use the <InlineCode>.onRequest()</InlineCode> function in a Job
          Trigger. You can filter so only data that matches your criteria triggers the Job.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Make sure your code is deployed (for Staging and Prod)" />
      <StepContentContainer>
        <Paragraph spacing>
          If you're using the Staging or Prod environment, you need to make sure your code is
          deployed. Deploy like you normally would –{" "}
          <TextLink to={docsPath("documentation/guides/deployment")}>
            read our deployment guide
          </TextLink>
          .
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Perform an action that sends a webhook" />
      <StepContentContainer>
        <Paragraph spacing>
          Now you need to actually perform an action on that third-party service that triggers the
          webhook you've subscribed to. For example, add a new meeting using Cal.com.
        </Paragraph>
      </StepContentContainer>

      <Callout variant="docs" to={docsPath("documentation/concepts/http-endpoints")}>
        Read the HTTP endpoints guide to learn more.
      </Callout>
    </>
  );
}
