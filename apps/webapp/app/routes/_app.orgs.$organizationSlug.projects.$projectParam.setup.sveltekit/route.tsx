import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import invariant from "tiny-invariant";
import { SvelteKitLogo } from "~/assets/logos/SveltekitLogo";
import { Feedback } from "~/components/Feedback";
import { RunDevCommand, TriggerDevStep } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useProjectSetupComplete } from "~/hooks/useProjectSetupComplete";
import { Handle } from "~/utils/handle";
import { projectSetupPath, trimTrailingSlash } from "~/utils/pathBuilder";
export const handle: Handle = {
  breadcrumb: (match) => (
    <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="SvelteKit" />
  ),
};

export default function SetUpSveltekit() {
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  invariant(devEnvironment, "Dev environment must be defined");
  return (
    <div className="mx-auto max-w-3xl pt-16">
      <div className="mb-12 grid place-items-center">
        <SvelteKitLogo className="w-72" />
      </div>
      <div className="flex items-center justify-between">
        <Header1 spacing className="text-bright">
          Get setup in 5 minutes
        </Header1>
        <div className="flex items-center gap-2">
          <LinkButton
            to={projectSetupPath(organization, project)}
            variant="tertiary/small"
            LeadingIcon={Squares2X2Icon}
          >
            Choose a different framework
          </LinkButton>
          <Feedback
            button={
              <Button variant="tertiary/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                I'm stuck!
              </Button>
            }
            defaultValue="help"
          />
        </div>
      </div>
      <div>
        <Callout
          variant={"info"}
          to="https://github.com/triggerdotdev/trigger.dev/discussions/430"
          className="mb-8"
        >
          Trigger.dev has full support for serverless. We will be adding support for long-running
          servers soon.
        </Callout>
        <div>
          <StepNumber
            stepNumber="1"
            title="Follow the steps from the Sveltekit manual installation guide"
          />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph className="mt-2">Copy your server API Key to your clipboard:</Paragraph>
            <div className="mb-2 flex w-full items-center justify-between">
              <ClipboardField
                secure
                className="w-fit"
                value={devEnvironment.apiKey}
                variant={"secondary/medium"}
                icon={<Badge variant="outline">Server</Badge>}
              />
            </div>
            <Paragraph>Now follow this guide:</Paragraph>
            <LinkButton
              to="https://trigger.dev/docs/documentation/guides/manual/sveltekit"
              variant="primary/medium"
              TrailingIcon="external-link"
            >
              Manual installation guide
            </LinkButton>
            <div className="flex items-start justify-start gap-2"></div>
          </StepContentContainer>
          <StepNumber stepNumber="2" title="Run your sveltekit app" />
          <StepContentContainer>
            <RunDevCommand extra=" -- --open --host" />
          </StepContentContainer>
          <StepNumber stepNumber="3" title="Run the CLI 'dev' command" />
          <StepContentContainer>
            <TriggerDevStep extra=" --port 5173" />
          </StepContentContainer>
          <StepNumber stepNumber="6" title="Wait for Jobs" displaySpinner />
          <StepContentContainer>
            <Paragraph>This page will automatically refresh.</Paragraph>
          </StepContentContainer>
        </div>
      </div>
    </div>
  );
}
