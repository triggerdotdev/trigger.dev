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
import { RunDevCommand, TriggerDevStep } from "~/components/SetupCommands";
import { Badge } from "~/components/primitives/Badge";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Remix" />,
};

export default function SetUpRemix() {
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  invariant(devEnvironment, "Dev environment must be defined");
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
            <StepNumber
              stepNumber="1"
              title="Follow the steps from the Remix manual installation guide"
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
                to="https://trigger.dev/docs/documentation/guides/manual/remix"
                variant="primary/medium"
                TrailingIcon="external-link"
              >
                Manual installation guide
              </LinkButton>
              <div className="flex items-start justify-start gap-2"></div>
            </StepContentContainer>
            <StepNumber stepNumber="2" title="Run your Remix app" />
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
    </PageGradient>
  );
}
