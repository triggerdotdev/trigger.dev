import { Paragraph, TextLink } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { IntegrationIcon } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations/route";
import { Callout } from "../primitives/Callout";
import integrationButton from "./integration-button.png";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { ClipboardField } from "../primitives/ClipboardField";
import { Button } from "../primitives/Buttons";

export function HowToSetupYourProject() {
  const devEnvironment = useDevEnvironment();
  console.log(devEnvironment);
  return (
    <>
      <StepNumber stepNumber="1" title="Run your Next.js app" />
      <StepContentContainer>
        <Paragraph>Ensure your Next.js app is running locally.</Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Run NGROK" />
      <StepContentContainer>
        <Paragraph spacing>Run NGROK in a new terminal window.</Paragraph>
        <Paragraph>
          We recommend using NGROK in order to establish a tunnel between your
          locally running Next.js app and the internet. Follow our{" "}
          <TextLink
            href="https://trigger.dev/docs/documentation/guides/tunneling-localhost"
            target="_blank"
          >
            guide to setting up NGROK
          </TextLink>{" "}
          before moving onto the next step.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Use the CLI" />
      <StepContentContainer>
        <Paragraph spacing>
          Run this CLI command in a new terminal window.
        </Paragraph>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`npx @trigger.dev/init -k ${devEnvironment?.apiKey} -t https://test-cloud.trigger.dev`}
        />
        <Paragraph spacing>
          The CLI will add Trigger.dev to your existing Next.js project, setup a
          route and give you an example file.
        </Paragraph>
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
      <StepNumber stepNumber="1" title="Step 1 title" />
      <StepContentContainer>
        <Paragraph>Content</Paragraph>
      </StepContentContainer>
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
