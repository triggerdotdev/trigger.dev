import { Paragraph, TextLink } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { IntegrationIcon } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations/route";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "../primitives/ClientTabs";
import { ClipboardField } from "../primitives/ClipboardField";
import integrationButton from "./integration-button.png";
import selectEnvironment from "./select-environment.png";
import selectExample from "./select-example.png";
import { InlineCode } from "../code/InlineCode";

export function HowToSetupYourProject() {
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();
  return (
    <>
      <StepNumber stepNumber="1" title="Run the CLI init command" />
      <StepContentContainer>
        <Paragraph spacing>
          Run this CLI command in a terminal window from your Next.js project.
        </Paragraph>
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
              value={`npx @trigger.dev/cli@latest init -k ${devEnvironment?.apiKey} -t ${appOrigin}`}
            />
          </ClientTabsContent>
          <ClientTabsContent value={"pnpm"}>
            <ClipboardField
              variant="primary/medium"
              className="mb-4"
              secure={`pnpm dlx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
              value={`pnpm dlx @trigger.dev/cli@latest init -k ${devEnvironment?.apiKey} -t ${appOrigin}`}
            />
          </ClientTabsContent>
          <ClientTabsContent value={"yarn"}>
            <ClipboardField
              variant="primary/medium"
              className="mb-4"
              secure={`yarn @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
              value={`yarn @trigger.dev/cli@latest init -k ${devEnvironment?.apiKey} -t ${appOrigin}`}
            />
          </ClientTabsContent>
        </ClientTabs>
        <Paragraph spacing variant="small">
          It will ask you for a "unique ID for your endpoint". You can use the
          default by hitting enter.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Run your Next.js app" />
      <StepContentContainer>
        <Paragraph>
          Ensure your Next.js app is running locally on port 3000.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Run the CLI dev command" />
      <StepContentContainer>
        <Paragraph spacing>
          The CLI <InlineCode>dev</InlineCode> command allows the Trigger.dev
          service to send messages to your Next.js site. This is required for
          registering Jobs, triggering them and running Tasks. To achieve this
          it creates a tunnel (using{" "}
          <TextLink href="https://ngrok.com/">ngrok</TextLink>) so Trigger.dev
          can send messages to your machine.
        </Paragraph>
        <Paragraph spacing>
          You should leave the <InlineCode>dev</InlineCode> command running when
          you're developing.
        </Paragraph>
        <Paragraph spacing>
          In a{" "}
          <strong className="text-bright">new terminal window or tab</strong>{" "}
          run:
        </Paragraph>
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
              value={`yarn @trigger.dev/cli@latest dev`}
            />
          </ClientTabsContent>
        </ClientTabs>
      </StepContentContainer>
      <StepNumber stepNumber="4" title="Check for Jobs" />
      <StepContentContainer>
        <Paragraph>
          Once you've run the CLI command, click Refresh to view your example
          Job in the list.
        </Paragraph>
        <Button
          variant="primary/medium"
          className="mt-4"
          LeadingIcon="refresh"
          onClick={() => window.location.reload()}
        >
          Refresh
        </Button>
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
        <Paragraph spacing>
          Select the environment you’d like the test to run against.
        </Paragraph>
        <img src={selectEnvironment} className="mt-2 w-52" />
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Write your test payload" />
      <StepContentContainer>
        <Paragraph spacing>
          Write your own payload specific to your Job. Some Triggers also
          provide example payloads that you can select from. This will populate
          the code editor below.
        </Paragraph>
        <img src={selectExample} className="mt-2 h-40" />
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Run your test" />
      <StepContentContainer>
        <Paragraph spacing>
          When you’re happy with the payload, click Run test.
        </Paragraph>
      </StepContentContainer>
      <Callout
        variant="docs"
        href="https://trigger.dev/docs/documentation/guides/testing-jobs"
      >
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
          <span
            className="mx-2 -mt-1 inline-flex"
            aria-label="Trigger.dev Integration icon"
          >
            <IntegrationIcon />
          </span>
          are Trigger.dev Integrations. These Integrations make connecting to
          the API easier by offering OAuth or API key authentication. All APIs
          can also be used with fetch or an SDK.
        </Paragraph>
        <img src={integrationButton} className="mt-2 h-10" />
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Choose how you want to connect" />
      <StepContentContainer>
        <Paragraph>
          Follow the instructions for your chosen connection method in the
          popover form. If no Integration exists yet, you can request one by
          clicking the "I want an Integration" button.
        </Paragraph>
      </StepContentContainer>
      <StepNumber
        stepNumber="3"
        title="Your connection will appear in the list"
      />
      <StepContentContainer>
        <Paragraph>
          Once you've connected your API, it will appear in the list of
          Integrations below. You can view details and manage your connection by
          selecting it from the table.
        </Paragraph>
      </StepContentContainer>
      <Callout
        variant={"docs"}
        href="https://trigger.dev/docs/integrations/introduction"
      >
        View the Integration docs page for more information on connecting an API
        using an Integration or other method.
      </Callout>
    </>
  );
}

export function HowToUseThisIntegration() {
  return (
    <>
      <StepNumber stepNumber="1" title="Step 1 title" />
      <StepContentContainer>
        <Paragraph>Content</Paragraph>
      </StepContentContainer>
    </>
  );
}

function StepContentContainer({ children }: { children: React.ReactNode }) {
  return <div className="mb-6 ml-9 mt-1">{children}</div>;
}
