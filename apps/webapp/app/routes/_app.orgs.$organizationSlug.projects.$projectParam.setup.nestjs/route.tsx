import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import invariant from "tiny-invariant";
import { Feedback } from "~/components/Feedback";
import { PageGradient } from "~/components/PageGradient";
import { StepContentContainer } from "~/components/StepContentContainer";
import { InlineCode } from "~/components/code/InlineCode";
import { InstallPackages } from "~/components/code/InstallPackages";
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
import { CodeBlock } from "../../components/code/CodeBlock";
import { TriggerDevStep } from "~/components/SetupCommands";

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
`;

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
    return \`Running Trigger.dev with client-id \${this.client.id}\`;
  }
}`;

const AppModuleWithControllerCode = `
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TriggerDevModule } from '@trigger.dev/nestjs';
import { JobController } from './job.controller';

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
  controllers: [
    //...existingControllers,
    JobController
  ],
})
export class AppModule {}
`;

const packageJsonCode = `"trigger.dev": {
  "endpointId": "my-nest-app"
}`;

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
            <InstallPackages
              packages={["@trigger.dev/sdk", "@trigger.dev/nestjs", "@nestjs/config"]}
            />
          </StepContentContainer>
          <StepNumber stepNumber="2" title="Add the environment variables" />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph>
              Inside your <InlineCode>.env</InlineCode> file, create the following env variables:
            </Paragraph>
            <CodeBlock
              fileName=".env"
              showChrome
              code={`TRIGGER_API_KEY=${devEnvironment.apiKey}\nTRIGGER_API_URL=${appOrigin}`}
            />
          </StepContentContainer>
          <StepNumber stepNumber="3" title="Add the TriggerDevModule" />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph>
              Now, go to your <InlineCode>app.module.ts</InlineCode> and add the{" "}
              <InlineCode>TriggerDevModule</InlineCode>:
            </Paragraph>
            <CodeBlock fileName="app.module.ts" showChrome code={AppModuleCode} />
          </StepContentContainer>
          <StepNumber stepNumber="4" title="Add the first job" />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph>
              Create a <InlineCode>controller</InlineCode> called{" "}
              <InlineCode>job.controller.ts</InlineCode> and add the following code:
            </Paragraph>
            <CodeBlock fileName="src/job.controller.ts" showChrome code={JobControllerCode} />
          </StepContentContainer>
          <StepNumber stepNumber="5" title="Update your app.module.ts" />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph>
              Now, add the new <InlineCode>controller</InlineCode> to your{" "}
              <InlineCode>app.module.ts</InlineCode>:
            </Paragraph>
            <CodeBlock fileName="app.module.ts" showChrome code={AppModuleWithControllerCode} />
          </StepContentContainer>
          <StepNumber stepNumber="6" title="Update your package.json" />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph>
              Now, add this to the top-level of your <InlineCode>package.json</InlineCode>:
            </Paragraph>
            <CodeBlock fileName="package.json" showChrome code={packageJsonCode} />
          </StepContentContainer>
          <StepNumber stepNumber="7" title="Run your app" />
          <StepContentContainer className="flex flex-col gap-2">
            <Paragraph>
              Finally, run your project with <InlineCode>npm run start</InlineCode>:
            </Paragraph>
          </StepContentContainer>
          <StepNumber stepNumber="8" title="Run the CLI 'dev' command" />
          <StepContentContainer>
            <TriggerDevStep />
          </StepContentContainer>
          <StepNumber stepNumber="9" title="Wait for Jobs" displaySpinner />
          <StepContentContainer>
            <Paragraph>This page will automatically refresh.</Paragraph>
          </StepContentContainer>
        </>
      </div>
    </PageGradient>
  );
}
