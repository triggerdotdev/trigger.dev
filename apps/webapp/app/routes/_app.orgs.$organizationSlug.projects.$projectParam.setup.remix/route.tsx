import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import invariant from "tiny-invariant";
import { Feedback } from "~/components/Feedback";
import { PageGradient } from "~/components/PageGradient";
import { StepContentContainer } from "~/components/StepContentContainer";
import { InlineCode } from "~/components/code/InlineCode";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header1 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useProjectSetupComplete } from "~/hooks/useProjectSetupComplete";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { projectSetupPath, trimTrailingSlash } from "~/utils/pathBuilder";
import { Callout } from "~/components/primitives/Callout";
import { TriggerDevStep } from "~/components/SetupCommands";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Remix" />,
};

export default function SetUpRemix() {
    const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();
  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
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
            <StepNumber stepNumber="1" title="Create a new Remix project" />
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
                    value={`npx create-remix@latest`}
                  />
                </ClientTabsContent>
                <ClientTabsContent value={"pnpm"}>
                  <ClipboardField
                    variant="primary/medium"
                    className="mb-4"
                    value={`pnpm create create-remix@latest`}
                  />
                </ClientTabsContent>
                <ClientTabsContent value={"yarn"}>
                  <ClipboardField
                    variant="primary/medium"
                    className="mb-4"
                    value={`yarn create-remix@latest`}
                  />
                </ClientTabsContent>
              </ClientTabs>
            </StepContentContainer>
            <StepNumber stepNumber="2" title="Navigate to your new Remix project" />
            <StepContentContainer>
              <Paragraph spacing>
                You have now created a new Remix project. Let’s <InlineCode>cd</InlineCode> into it
                using the project name you just provided:
              </Paragraph>
              <ClipboardField
                value={"cd [replace with your project name]"}
                variant={"primary/medium"}
              ></ClipboardField>
            </StepContentContainer>
            <StepNumber stepNumber="3" title="Follow the step from the Remix manual installation guide" />
            <StepContentContainer>
            <LinkButton to="" variant="primary/medium"/>
            </StepContentContainer>
            <StepNumber stepNumber="5" title="Run the CLI 'dev' command" />
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
    </PageGradient>
    
  );
}
