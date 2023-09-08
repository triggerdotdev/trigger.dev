import { useState } from "react";
import invariant from "tiny-invariant";
import { useProjectSetupComplete } from "~/hooks/useProjectSetupComplete";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { projectSetupPath, trimTrailingSlash } from "~/utils/pathBuilder";
import { Callout } from "~/components/primitives/Callout";
import { StepNumber } from "~/components/primitives/StepNumber";
import { StepContentContainer } from "~/components/StepContentContainer";
import { RunDevCommand, TriggerDevStep, InitCommand } from "~/components/SetupCommands";
import { Header1 } from "~/components/primitives/Headers";
import { LinkButton } from "~/components/primitives/Buttons";
import { PageGradient } from "~/components/PageGradient";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { InlineCode } from "~/components/code/InlineCode";
import { ClipboardField } from "~/components/primitives/ClipboardField";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Express" />,
};

export default function SetupExpress() {
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();

  invariant(devEnvironment, "devEnvironment is required");

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <Header1 spacing className="text-bright">
          Get setup in 2 minutes for an existing Express project
        </Header1>
        <Callout
          variant={"info"}
          to="https://github.com/triggerdotdev/trigger.dev/discussions/451"
          className="mb-8"
        >
          Trigger.dev has full support for serverless. We will be adding support for
          long-running servers soon.
        </Callout>
        <StepNumber stepNumber="1" title="Run the CLI 'init' command in your existing Express project" />
        <StepContentContainer>
          <InitCommand appOrigin={appOrigin} apiKey={devEnvironment.apiKey} />
          <Paragraph spacing variant="small">
            You’ll notice a new folder in your project called 'jobs'. We’ve added a very
            simple example Job in <InlineCode variant="extra-small">examples.ts</InlineCode>{" "}
            to help you get started.
          </Paragraph>
        </StepContentContainer>
        <StepNumber stepNumber="2" title="Run your Express app" />
        <StepContentContainer>
          <RunDevCommand />
        </StepContentContainer>
        <StepNumber stepNumber="3" title="Run the CLI 'dev' command" />
        <StepContentContainer>
          <TriggerDevStep />
        </StepContentContainer>
        <StepNumber stepNumber="4" title="Wait for Jobs" displaySpinner />
        <StepContentContainer>
          <Paragraph>This page will automatically refresh.</Paragraph>
        </StepContentContainer>
      </div>
    </PageGradient>
  );
}
