import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import invariant from "tiny-invariant";
import { AstroLogo } from "~/assets/logos/AstroLogo";
import { Feedback } from "~/components/Feedback";
import { InitCommand, RunDevCommand, TriggerDevStep } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { InlineCode } from "~/components/code/InlineCode";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useProjectSetupComplete } from "~/hooks/useProjectSetupComplete";
import { Handle } from "~/utils/handle";
import { projectSetupPath, trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Astro" />,
};

export default function SetUpAstro() {
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  invariant(devEnvironment, "Dev environment must be defined");
  const appOrigin = useAppOrigin();

  return (
    <div className="mx-auto max-w-3xl pt-16">
      <div className="mb-12 grid place-items-center">
        <AstroLogo className="w-64" />
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
            title="Run the CLI 'init' command in an existing Astro project"
          />
          <StepContentContainer>
            <InitCommand appOrigin={appOrigin} apiKey={devEnvironment.apiKey} />

            <Paragraph spacing variant="small">
              You’ll notice a new folder in your project called 'jobs'. We’ve added a very simple
              example Job in <InlineCode variant="extra-small">example.ts</InlineCode> to help you
              get started.
            </Paragraph>
          </StepContentContainer>
          <StepNumber stepNumber="2" title="Run your Astro app" />
          <StepContentContainer>
            <RunDevCommand />
          </StepContentContainer>
          <StepNumber stepNumber="3" title="Run the CLI 'dev' command" />
          <StepContentContainer>
            <TriggerDevStep />
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
