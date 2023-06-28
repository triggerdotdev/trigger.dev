import { Paragraph, TextLink } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { IntegrationIcon } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations/route";
import { Callout } from "../primitives/Callout";
import integrationButton from "./integration-button.png";
import ngrok from "./ngrok.png";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { ClipboardField } from "../primitives/ClipboardField";
import { Button } from "../primitives/Buttons";
import { InlineCode } from "../code/InlineCode";

export function HowToSetupYourProject() {
  const devEnvironment = useDevEnvironment();
  return (
    <>
      <StepNumber stepNumber="1" title="Run your Next.js app" />
      <StepContentContainer>
        <Paragraph>
          Ensure your Next.js app is running locally on port 3000.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Create a tunnel to your Next.js app" />
      <StepContentContainer>
        <Paragraph spacing>
          There are a few ways to do this, but we recommend using{" "}
          <TextLink
            href="https://trigger.dev/docs/documentation/guides/tunneling-localhost"
            target="_blank"
          >
            ngrok
          </TextLink>
          . It’s free and easy to use and required to create a tunnel, making
          your local machine accessible to the internet.
        </Paragraph>
        <StepNumber stepNumber="a" title="Install ngrok" />
        <StepContentContainer>
          <ClipboardField
            variant="primary/medium"
            fullWidth={false}
            className="mt-2"
            value={`brew install ngrok/ngrok/ngrok`}
          />
        </StepContentContainer>
        <StepNumber stepNumber="b" title="Open a new terminal window/tab" />
        <StepContentContainer>
          <Paragraph spacing>You need to leave this running.</Paragraph>
        </StepContentContainer>
        <StepNumber stepNumber="c" title="Create an http tunnel at port 3000" />
        <StepContentContainer>
          <Paragraph spacing>
            This creates a tunnel to your Next.js app.
          </Paragraph>
          <ClipboardField
            variant="primary/medium"
            fullWidth={false}
            className="mb-4"
            value={`ngrok http 3000`}
          />
        </StepContentContainer>
        <StepNumber
          stepNumber="d"
          title="Grab your public URL in the ngrok output"
        />
        <StepContentContainer>
          <img src={ngrok} className="mt-2 w-full" />
        </StepContentContainer>
        <StepNumber
          stepNumber="d"
          title="Use the forwarding URL (public URL)"
        />
        <StepContentContainer>
          <Paragraph spacing>
            Use the public URL that ngrok gave you for the{" "}
            <InlineCode>VERCEL_URL</InlineCode> environment variable.
          </Paragraph>
        </StepContentContainer>
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Use the CLI" />
      <StepContentContainer>
        <Paragraph spacing>
          Run this CLI command in a new terminal window.{" "}
        </Paragraph>
        <Paragraph spacing>
          Use the public URL that you copied from step 2d for the -u
          placeholder.
        </Paragraph>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure="npx @trigger.dev/init@latest -k ••••••••• -t https://test-cloud.trigger.dev -u <ngrok public url>"
          value={`npx @trigger.dev/init@latest -k ${devEnvironment?.apiKey} -t https://test-cloud.trigger.dev -u <ngrok public url>`}
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
