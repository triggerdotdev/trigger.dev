import { useProjectSetupComplete } from "~/hooks/useProjectSetupComplete";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";
import { Callout } from "~/components/primitives/Callout";
import { StepNumber } from "~/components/primitives/StepNumber";
import { StepContentContainer } from "~/components/StepContentContainer";
import { RunDevCommand, TriggerDevStep, InitCommand } from "~/components/SetupCommands";
import { Header1 } from "~/components/primitives/Headers";
import { PageGradient } from "~/components/PageGradient";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Paragraph } from "~/components/primitives/Paragraph";
import invariant from "tiny-invariant";
import { LinkButton } from "~/components/primitives/Buttons";


// Define breadcrumb handling for this page
export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Express" />,
};

// Express setup component
export default function SetupExpress() {
  // Fetch necessary data from hooks
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();

  // Ensure devEnvironment is available
  invariant(devEnvironment, "devEnvironment is required");

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <Header1 spacing className="text-bright">
          Get setup in 2 minutes for an existing Express project
        </Header1>

        {/* Callout with information */}
        <Callout
          variant={"info"}
          to="https://github.com/triggerdotdev/trigger.dev/discussions/451"
          className="mb-8"
        >
          Trigger.dev has full support for serverless. We will be adding support for
          long-running servers soon.
        </Callout>

        {/* Step 1 */}
        <StepNumber stepNumber="1" title="Manually set up Trigger.dev in your existing Express project" />
        <StepContentContainer>
          <InitCommand appOrigin={appOrigin} apiKey={devEnvironment.apiKey} />
          <Paragraph spacing variant="small">
            To set up Trigger.dev in your existing Express project, please follow the manual installation guide in the documentation:
          </Paragraph>
          <LinkButton to="https://trigger.dev/docs/documentation/quickstarts/express" variant="primary">
            Manual Installation Guide
          </LinkButton>
          <Paragraph spacing variant="small">
            This guide will walk you through the necessary steps for setting up Trigger.dev with Express.js.
          </Paragraph>
        </StepContentContainer>

        {/* Step 2 */}
        <StepNumber stepNumber="2" title="Run your Express app" />
        <StepContentContainer>
          <RunDevCommand />
        </StepContentContainer>

        {/* Step 3 */}
        <StepNumber stepNumber="3" title="Run the CLI 'dev' command" />
        <StepContentContainer>
          <TriggerDevStep />
        </StepContentContainer>

        {/* Step 4 */}
        <StepNumber stepNumber="4" title="Wait for Jobs" displaySpinner />
        <StepContentContainer>
          <Paragraph>This page will refresh itself.</Paragraph>
        </StepContentContainer>
      </div>
    </PageGradient>
  );
}
