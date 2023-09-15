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
import { CodeBlock } from "~/components/code/CodeBlock";
import {
  ClientTabs,
  ClientTabsList,
  ClientTabsTrigger,
  ClientTabsContent,
} from "~/components/primitives/ClientTabs";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="NestJS" />,
};

export default function Page() {
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();

  invariant(devEnvironment, "devEnvironment is required");

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <Header1 spacing className="text-bright">
          Get setup in 5 minutes for an existing Fastify project
        </Header1>
        <Callout
          variant={"info"}
          to="https://github.com/triggerdotdev/trigger.dev/issues/450"
          className="mb-8"
        >
          Trigger.dev has full support for serverless. We will be adding support for long-running
          servers soon.
        </Callout>
        <StepNumber
          stepNumber="1"
          title="Install the necessary packages in your Fastify project directory"
        />
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
                value={`npm install @trigger.dev/sdk @trigger-dev/fastify`}
              />
            </ClientTabsContent>
            <ClientTabsContent value={"pnpm"}>
              <ClipboardField
                variant="primary/medium"
                className="mb-4"
                value={`pnpm install @trigger.dev/sdk @trigger-dev/fastify`}
              />
            </ClientTabsContent>
            <ClientTabsContent value={"yarn"}>
              <ClipboardField
                variant="primary/medium"
                className="mb-4"
                value={`yarn add @trigger.dev/sdk @trigger-dev/fastify`}
              />
            </ClientTabsContent>
          </ClientTabs>
        </StepContentContainer>
        <StepNumber
          stepNumber="2"
          title="Create a `.env` file at the root of your project and include your Trigger API key and URL like this:"
        />
        <StepContentContainer>
          <CodeBlock
            showLineNumbers={false}
            className="mb-4"
            code={`TRIGGER_API_KEY = ENTER_YOUR_DEVELOPMENT_API_KEY_HERE
TRIGGER_API_URL = https://cloud.trigger.dev
        `}
          />
        </StepContentContainer>
        <StepNumber
          stepNumber="3"
          title="In your project directory, create a configuration file named `trigger.ts` and add the following code:"
        />
        <StepContentContainer>
          <CodeBlock
            showLineNumbers={false}
            className="mb-4"
            code={`import { TriggerClient } from "@trigger.dev/sdk";
        
export const client = new TriggerClient({
  id: "my-app",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});

client.defineJob({
  id: 'example-job',
  name: 'Example Job',
  version: '0.0.1',
  trigger: eventTrigger({
    name: 'example.event',
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info('Hello world!', { payload });

    return {
      message: 'Hello world!',
    };
  },
});
        `}
          />
          <Paragraph spacing variant="small">
            Replace "my-app" with an appropriate identifier for your project.
          </Paragraph>
        </StepContentContainer>
        <StepNumber
          stepNumber="4"
          title="In `server.[js/ts]` create a middleware for the specific `/api/trigger` route."
        />
        <StepContentContainer>
          <CodeBlock
            showLineNumbers={false}
            className="mb-4"
            code={`
        
// In server.[js/ts]
import fastify from "fastify";
import { createMiddleware } from "@trigger.dev/fastify";
import { client } from "./trigger";

const app = fastify({
  logger: true,
});

const middleware = createMiddleware(client);

app.addHook("preHandler", middleware);

app.listen({ port: 3000 }, () => {
  console.log("Listening on port 3000");
});`}
          />
        </StepContentContainer>
        <StepNumber stepNumber="5" title="Start your Fastify project" />
        <StepContentContainer> </StepContentContainer>
        <StepNumber stepNumber="6" title="Run the CLI 'dev' command" />
        <StepContentContainer>
          <TriggerDevStep />
        </StepContentContainer>
        <StepNumber stepNumber="7" title="Wait for Jobs" displaySpinner />
        <StepContentContainer>
          <Paragraph>This page will automatically refresh.</Paragraph>
        </StepContentContainer>
      </div>
    </PageGradient>
  );
}
