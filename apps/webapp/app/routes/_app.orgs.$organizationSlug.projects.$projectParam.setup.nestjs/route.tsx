import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import invariant from "tiny-invariant";
import { Feedback } from "~/components/Feedback";
import { PageGradient } from "~/components/PageGradient";
import { InitCommand, RunDevCommand, TriggerDevStep } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { InlineCode } from "~/components/code/InlineCode";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Button, LinkButton } from "~/components/primitives/Buttons";
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
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "../../components/primitives/ClientTabs";
import { ClipboardField } from "../../components/primitives/ClipboardField";
import { CodeBlock } from "../../components/code/CodeBlock";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="NestJS" />,
};

const AppModuleCode = `
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TriggerDevModule } from '@trigger.dev/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TriggerDevModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        id: 'my-nest-app',
        apiKey: config.getOrThrow('TRIGGER_API_KEY'),
        apiUrl: config.getOrThrow('TRIGGER_API_URL'),
        verbose: false,
        ioLogLocalEnabled: true,
      }),
    }),
  ],
})
export class AppModule {}
`

const JobControllerCode = `
import { Controller, Get } from '@nestjs/common';
import { InjectTriggerDevClient } from '@trigger.dev/nestjs';
import { eventTrigger, TriggerClient } from '@trigger.dev/sdk';

@Controller()
export class JobController {
  constructor(
    @InjectTriggerDevClient() private readonly client: TriggerClient,
  ) {
    this.client.defineJob({
      id: 'test-job',
      name: 'Test Job One',
      version: '0.0.1',
      trigger: eventTrigger({
        name: 'test.event',
      }),
      run: async (payload, io, ctx) => {
        await io.logger.info('Hello world!', { payload });

        return {
          message: 'Hello world!',
        };
      },
    });
  }

  @Get()
  getHello(): string {
    return \`Running Trigger.dev with client-id \${ this.client.id }\`;
  }
}
`;

const AppModuleWithControllerCode = `
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TriggerDevModule } from '@trigger.dev/nestjs';
import { JobController } from './job.controller';

@Module({
  imports: [
    controllers: [JobController],
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TriggerDevModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        id: 'my-nest-app',
        apiKey: config.getOrThrow('TRIGGER_API_KEY'),
        apiUrl: config.getOrThrow('TRIGGER_API_URL'),
        verbose: false,
        ioLogLocalEnabled: true,
      }),
    }),
  ],
})
export class AppModule {}
`

export default function SetupNestJS() {
  const organization = useOrganization();
  const project = useProject();
  useProjectSetupComplete();
  const devEnvironment = useDevEnvironment();
  const appOrigin = useAppOrigin();

  invariant(devEnvironment, "devEnvironment is required");

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <Header1 spacing className="text-bright">
            Get setup in 2 minutes
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
        <>
          <StepNumber stepNumber="1" title="Add the dependencies" />
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
                  secure={`npm install @trigger.dev/sdk @trigger.dev/nestjs`}
                  value={`npm install @trigger.dev/sdk @trigger.dev/nestjs`}
                />
              </ClientTabsContent>
              <ClientTabsContent value={"pnpm"}>
                <ClipboardField
                  variant="primary/medium"
                  className="mb-4"
                  secure={`pnpm install @trigger.dev/sdk @trigger.dev/nestjs`}
                  value={`pnpm install @trigger.dev/sdk @trigger.dev/nestjs`}
                />
              </ClientTabsContent>
              <ClientTabsContent value={"yarn"}>
                <ClipboardField
                  variant="primary/medium"
                  className="mb-4"
                  secure={`yarn add @trigger.dev/sdk @trigger.dev/nestjs`}
                  value={`yarn add @trigger.dev/sdk @trigger.dev/nestjs`}
                />
              </ClientTabsContent>
            </ClientTabs>
          </StepContentContainer>
          <StepNumber stepNumber="2" title="Add the environment variables" />
          <StepContentContainer>
            <Paragraph>
              Inside your `.env` file, create the following env variables:
              <InlineCode variant="extra-small">TRIGGER_API_KEY={devEnvironment.apiKey}</InlineCode> and
              <InlineCode variant="extra-small">TRIGGER_API_URL={appOrigin}</InlineCode>
            </Paragraph>
          </StepContentContainer>
          <StepNumber stepNumber="3" title="Add the TriggerDevModule" />
          <StepContentContainer>
            <Paragraph>Now, go to your <InlineCode>app.module.ts</InlineCode> and add the <InlineCode>TriggerDevModule</InlineCode>:</Paragraph>
            <CodeBlock code={AppModuleCode}></CodeBlock>
          </StepContentContainer>
          <StepNumber stepNumber="4" title="Add the first job" />
          <StepContentContainer>
            <Paragraph>Create a <InlineCode>controller</InlineCode> called <InlineCode>job.controller.ts</InlineCode> and add the following code:</Paragraph>
            <CodeBlock code={JobControllerCode}></CodeBlock>
          </StepContentContainer>
          <StepNumber stepNumber="5" title="Update your app.module.ts" />
          <StepContentContainer>
            <Paragraph>Now, add the new <InlineCode>controller</InlineCode> to your <InlineCode>app.module.ts</InlineCode>:</Paragraph>
            <CodeBlock code={AppModuleWithControllerCode}></CodeBlock>
          </StepContentContainer>
          <StepNumber stepNumber="6" title="Run your app" />
          <StepContentContainer>
            <Paragraph>Finally, run your project with <InlineCode>npm run start</InlineCode>:</Paragraph>
          </StepContentContainer>
          <StepNumber stepNumber="7" title="Wait for Jobs" displaySpinner />
          <StepContentContainer>
            <Paragraph>This page will automatically refresh.</Paragraph>
          </StepContentContainer>
        </>
      </div>
    </PageGradient>
  );
}
