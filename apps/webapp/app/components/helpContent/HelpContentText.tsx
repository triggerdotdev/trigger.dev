import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { Link, useRevalidator } from "@remix-run/react";
import { useEffect, useState } from "react";
import { useEventSource } from "remix-utils";
import invariant from "tiny-invariant";
import gradientBackground from "~/assets/images/gradient-background.png";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { IntegrationIcon } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations/route";
import { jobTestPath, projectStreamingPath } from "~/utils/pathBuilder";
import { Feedback } from "../Feedback";
import { CodeBlock } from "../code/CodeBlock";
import { InlineCode } from "../code/InlineCode";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { HelpPanelProps } from "../integrations/ApiKeyHelp";
import { HelpInstall } from "../integrations/HelpInstall";
import { HelpSamples } from "../integrations/HelpSamples";
import { Button, LinkButton } from "../primitives/Buttons";
import { Callout, variantClasses } from "../primitives/Callout";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "../primitives/ClientTabs";
import { ClipboardField } from "../primitives/ClipboardField";
import { Header1, Header2 } from "../primitives/Headers";
import { NamedIcon } from "../primitives/NamedIcon";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";
import { TextLink } from "../primitives/TextLink";
import integrationButton from "./integration-button.png";
import selectEnvironment from "./select-environment.png";
import selectExample from "./select-example.png";

type SelectionChoices = "use-existing-project" | "create-new-next-app";

export function HowToSetupYourProject() {
  const project = useProject();
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();

  const [selectedValue, setSelectedValue] = useState<SelectionChoices | null>(null);

  invariant(devEnvironment, "devEnvironment is required");

  const revalidator = useRevalidator();
  const events = useEventSource(projectStreamingPath(project.id), {
    event: "message",
  });

  useEffect(() => {
    if (events !== null) {
      // This uses https://www.npmjs.com/package/canvas-confetti
      if ("confetti" in window && typeof window.confetti !== "undefined") {
        const duration = 3.5 * 1000;
        const animationEnd = Date.now() + duration;
        const defaults = {
          startVelocity: 30,
          spread: 360,
          ticks: 60,
          zIndex: 0,
          colors: [
            "#E7FF52",
            "#41FF54",
            "rgb(245 158 11)",
            "rgb(22 163 74)",
            "rgb(37 99 235)",
            "rgb(67 56 202)",
            "rgb(219 39 119)",
            "rgb(225 29 72)",
            "rgb(217 70 239)",
          ],
        };
        function randomInRange(min: number, max: number): number {
          return Math.random() * (max - min) + min;
        }
        // @ts-ignore
        const interval = setInterval(function () {
          const timeLeft = animationEnd - Date.now();

          if (timeLeft <= 0) {
            return clearInterval(interval);
          }

          const particleCount = 60 * (timeLeft / duration);
          // since particles fall down, start a bit higher than random
          // @ts-ignore
          window.confetti(
            Object.assign({}, defaults, {
              particleCount,
              origin: { x: randomInRange(0.1, 0.4), y: Math.random() - 0.2 },
            })
          );
          // @ts-ignore
          window.confetti(
            Object.assign({}, defaults, {
              particleCount,
              origin: { x: randomInRange(0.6, 0.9), y: Math.random() - 0.2 },
            })
          );
        }, 250);
      }

      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="-ml-4 -mt-4 h-full w-[calc(100%+32px)] bg-cover bg-no-repeat pt-20"
      style={{ backgroundImage: `url("${gradientBackground}")` }}
    >
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <Header1 spacing className="text-bright">
            Get setup in {selectedValue === "create-new-next-app" ? "5" : "2"} minutes
          </Header1>
          <Feedback
            button={
              <Button variant="secondary/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                I'm stuck!
              </Button>
            }
            defaultValue="help"
          />
        </div>
        <RadioGroup
          className="mb-4 flex gap-x-2"
          onValueChange={(value) => setSelectedValue(value as SelectionChoices)}
        >
          <RadioGroupItem
            label="Use an existing Next.js project"
            description="Use Trigger.dev in an existing Next.js project in less than 2 mins."
            value="use-existing-project"
            checked={selectedValue === "use-existing-project"}
            variant="icon"
            data-action="use-existing-project"
            icon={<NamedIcon className="h-12 w-12 text-green-600" name={"tree"} />}
          />
          <RadioGroupItem
            label="Create a new Next.js project"
            description="This is the quickest way to try out Trigger.dev in a new Next.js project and takes 5 mins."
            value="create-new-next-app"
            checked={selectedValue === "create-new-next-app"}
            variant="icon"
            data-action="create-new-next-app"
            icon={<NamedIcon className="h-8 w-8 text-green-600" name={"sapling"} />}
          />
        </RadioGroup>
        {selectedValue && (
          <>
            {selectedValue === "create-new-next-app" ? (
              <>
                <StepNumber stepNumber="1" title="Create a new Next.js project" />
                <StepContentContainer>
                  <ClientTabs defaultValue="npm">
                    <ClientTabsList>
                      <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
                      <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
                      <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
                    </ClientTabsList>
                    <ClientTabsContent value={"npm"}>
                      <ClipboardField
                        variant="primary/medium"
                        className="mb-4"
                        value={`npx create-next-app@latest`}
                      />
                    </ClientTabsContent>
                    <ClientTabsContent value={"pnpm"}>
                      <ClipboardField
                        variant="primary/medium"
                        className="mb-4"
                        value={`pnpm create next-app`}
                      />
                    </ClientTabsContent>
                    <ClientTabsContent value={"yarn"}>
                      <ClipboardField
                        variant="primary/medium"
                        className="mb-4"
                        value={`yarn create next-app`}
                      />
                    </ClientTabsContent>
                  </ClientTabs>

                  <Paragraph spacing variant="small">
                    Trigger.dev works with either the Pages or App Router configuration.
                  </Paragraph>
                </StepContentContainer>
                <StepNumber stepNumber="2" title="Navigate to your new Next.js project" />
                <StepContentContainer>
                  <Paragraph spacing>
                    You have now created a new Next.js project. Let’s <InlineCode>cd</InlineCode>{" "}
                    into it using the project name you just provided:
                  </Paragraph>
                  <ClipboardField
                    value={"cd [replace with your project name]"}
                    variant={"primary/medium"}
                  ></ClipboardField>
                </StepContentContainer>
                <StepNumber
                  stepNumber="3"
                  title="Run the CLI 'init' command in your new Next.js project"
                />
                <StepContentContainer>
                  <InitCommand appOrigin={appOrigin} apiKey={devEnvironment.apiKey} />
                  <Paragraph spacing variant="small">
                    You’ll notice a new folder in your project called 'jobs'. We’ve added a very
                    simple example Job in <InlineCode variant="extra-small">examples.ts</InlineCode>{" "}
                    to help you get started.
                  </Paragraph>
                </StepContentContainer>
                <StepNumber stepNumber="4" title="Run your Next.js app" />
                <StepContentContainer>
                  <NextDevCommand />
                </StepContentContainer>
                <StepNumber stepNumber="5" title="Run the CLI 'dev' command" />
                <StepContentContainer>
                  <TriggerDevStep />
                </StepContentContainer>
                <StepNumber stepNumber="6" title="Wait for Jobs" displaySpinner />
                <StepContentContainer>
                  <Paragraph>This page will automatically refresh.</Paragraph>
                </StepContentContainer>
              </>
            ) : (
              <>
                <StepNumber
                  stepNumber="1"
                  title="Run the CLI 'init' command in an existing Next.js project"
                />
                <StepContentContainer>
                  <InitCommand appOrigin={appOrigin} apiKey={devEnvironment.apiKey} />

                  <Paragraph spacing variant="small">
                    You’ll notice a new folder in your project called 'jobs'. We’ve added a very
                    simple example Job in <InlineCode variant="extra-small">examples.ts</InlineCode>{" "}
                    to help you get started.
                  </Paragraph>
                </StepContentContainer>
                <StepNumber stepNumber="2" title="Run your Next.js app" />
                <StepContentContainer>
                  <NextDevCommand />
                </StepContentContainer>
                <StepNumber stepNumber="3" title="Run the CLI 'dev' command" />
                <StepContentContainer>
                  <TriggerDevStep />
                </StepContentContainer>
                <StepNumber stepNumber="4" title="Wait for Jobs" displaySpinner />
                <StepContentContainer>
                  <Paragraph>This page will automatically refresh.</Paragraph>
                </StepContentContainer>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function HowToRunYourJob() {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  return (
    <>
      <Callout variant="info" className="mb-6">
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

function StepContentContainer({ children }: { children: React.ReactNode }) {
  return <div className="mb-6 ml-9 mt-1">{children}</div>;
}

function InitCommand({ appOrigin, apiKey }: { appOrigin: string; apiKey: string }) {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure={`npx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
          value={`npx @trigger.dev/cli@latest init -k ${apiKey} -t ${appOrigin}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure={`pnpm dlx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
          value={`pnpm dlx @trigger.dev/cli@latest init -k ${apiKey} -t ${appOrigin}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure={`yarn dlx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
          value={`yarn dlx @trigger.dev/cli@latest init -k ${apiKey} -t ${appOrigin}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

function NextDevCommand() {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField variant="primary/medium" className="mb-4" value={`npm run dev`} />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField variant="primary/medium" className="mb-4" value={`pnpm run dev`} />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField variant="primary/medium" className="mb-4" value={`yarn run dev`} />
      </ClientTabsContent>
    </ClientTabs>
  );
}

function TriggerDevCommand() {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`npx @trigger.dev/cli@latest dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`pnpm dlx @trigger.dev/cli@latest dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`yarn dlx @trigger.dev/cli@latest dev`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

function TriggerDevStep() {
  return (
    <>
      <Paragraph spacing>
        In a <span className="text-amber-400">separate terminal window or tab</span> run:
      </Paragraph>
      <TriggerDevCommand />
      <Paragraph spacing variant="small">
        If you’re not running on port 3000 you can specify the port by adding{" "}
        <InlineCode variant="extra-small">--port 3001</InlineCode> to the end.
      </Paragraph>
      <Paragraph spacing variant="small">
        You should leave the <InlineCode variant="extra-small">dev</InlineCode> command running when
        you're developing.
      </Paragraph>
    </>
  );
}
