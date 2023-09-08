import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import { useState } from "react";
import invariant from "tiny-invariant";
import { Feedback } from "~/components/Feedback";
import { PageGradient } from "~/components/PageGradient";
import { InitCommand, NextDevCommand, TriggerDevStep } from "~/components/SetupCommands";
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
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import { StepNumber } from "~/components/primitives/StepNumber";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useProjectSetupComplete } from "~/hooks/useProjectSetupComplete";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { projectSetupPath, trimTrailingSlash } from "~/utils/pathBuilder";

type SelectionChoices = "use-existing-project" | "create-new-next-app";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Next.js" />,
};

export default function SetupNextjs() {
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();
  const [selectedValue, setSelectedValue] = useState<SelectionChoices | null>(null);

  invariant(devEnvironment, "devEnvironment is required");

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <Header1 spacing className="text-bright">
            Get setup in {selectedValue === "create-new-next-app" ? "5" : "2"} minutes
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
    </PageGradient>
  );
}
