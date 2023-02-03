import { Tab } from "@headlessui/react";
import {
  LargeBox,
  LargeBoxList,
  Underlined,
  UnderlinedList,
} from "~/components/StyledTabs";
import {
  ArrowTopRightOnSquareIcon,
  EnvelopeIcon,
  StarIcon,
} from "@heroicons/react/24/outline";
import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import { PrimaryA, SecondaryA, TertiaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { SubTitle } from "./primitives/text/SubTitle";
import { newUserSlackMessage } from "./samples/new-user-slack-message";
import CodeBlock from "./code/CodeBlock";
import { Header4 } from "./primitives/text/Headers";
import classNames from "classnames";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import invariant from "tiny-invariant";
import { ReactNode } from "react";

export function CreateNewWorkflow() {
  return (
    <>
      <SubTitle>Create a new workflow</SubTitle>
      <div className="flex gap-2">
        <PrimaryA
          href="https://docs.trigger.dev"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          <span>Documentation</span>
        </PrimaryA>
        <SecondaryA
          href="https://docs.trigger.dev/examples/examples"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          <span>Example Workflows</span>
        </SecondaryA>
      </div>
    </>
  );
}

export function CreateNewWorkflowNoWorkflows({
  providers,
}: {
  providers: IntegrationMetadata[];
}) {
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment must be defined");
  return (
    <>
      <Header4 size="regular" className={subTitle}>
        1. Install the Trigger.dev package
      </Header4>
      <InstallPackages packages={"@trigger.dev/sdk"} />
      <Header4 size="regular" className={classNames("mt-10", subTitle)}>
        2. Create your workflow
      </Header4>
      <Tab.Group>
        <UnderlinedList>
          <Underlined>Start from an example</Underlined>
          <Underlined>Start from scratch</Underlined>
        </UnderlinedList>
        <Tab.Panels className="flex-grow pt-4">
          <Tab.Panel className="relative h-full">
            {/* Example projects tabs */}
            <Tab.Group>
              <LargeBoxList>
                {exampleProjects.map((project) => {
                  return (
                    <LargeBox key={project.name}>
                      {project.icon}
                      <Body>{project.name}</Body>
                    </LargeBox>
                  );
                })}
              </LargeBoxList>
              {/* Example projects content */}
              <Tab.Panels className="flex-grow pt-4">
                {exampleProjects.map((project) => {
                  return (
                    <Tab.Panel key={project.name} className="relative h-full">
                      <Header4
                        size="small"
                        className="mb-2 font-semibold text-slate-300"
                      >
                        {project.title}
                      </Header4>
                      <Body size="regular" className="mb-4 text-slate-400">
                        {project.description}
                      </Body>
                      <Body size="regular" className="mb-2 text-slate-400">
                        Install these extra API integration packages:
                      </Body>
                      <InstallPackages packages={project.requiredPackages} />
                      <Body size="regular" className="mb-2 text-slate-400">
                        Copy this code into your project. Your API key is
                        already inserted.
                      </Body>
                      <CodeBlock
                        code={project.code(environment.apiKey)}
                        align="top"
                      />
                    </Tab.Panel>
                  );
                })}
              </Tab.Panels>
            </Tab.Group>
          </Tab.Panel>
          <Tab.Panel className="relative h-full">
            <Tab.Group>
              {/* From scratch projects titles */}
              <LargeBoxList>
                {fromScratchProjects.map((project) => {
                  return <LargeBox key={project.name}>{project.name}</LargeBox>;
                })}
              </LargeBoxList>
              {/* From scratch projects content */}
              <Tab.Panels className="flex-grow pt-4">
                {fromScratchProjects.map((project) => {
                  return (
                    <Tab.Panel key={project.name} className="relative h-full">
                      <CodeBlock
                        code={project.code(environment.apiKey)}
                        align="top"
                      />
                    </Tab.Panel>
                  );
                })}
              </Tab.Panels>
            </Tab.Group>
          </Tab.Panel>
        </Tab.Panels>
      </Tab.Group>
      <Header4 size="regular" className={classNames(subTitle, "mt-8")}>
        3. Run your web server
      </Header4>
      <Body size="regular" className="mb-4 text-slate-400">
        Run your server how you normally would, e.g.{" "}
        <InlineCode>npm run dev</InlineCode>. This will connect your workflow to
        Trigger.dev, so we can start sending you events. You should see some log
        messages in your server console (tip: you can turn these off by removing
        the <InlineCode>logLevel: "info"</InlineCode> from the code above).
      </Body>
      <Header4 size="regular" className={classNames(subTitle, "mt-8")}>
        4. Test your workflow from the dashboard
      </Header4>
      <Body size="regular" className="mb-4 text-slate-400">
        Now that the workflow is connected to Trigger.dev we need to trigger it.
        You can easily test your workflow from your{" "}
        <TertiaryA
          href="https://app.trigger.dev/"
          className="!text-base text-slate-400 underline decoration-green-500 underline-offset-2 transition hover:decoration-[3px]"
        >
          Trigger.dev
        </TertiaryA>{" "}
        dashboard.
      </Body>
      <Body size="regular" className="mb-4 text-slate-400">
        On the organization page you should see that the Workflow has now
        appeared (you may need to refresh the page from last time).
      </Body>
      <Body size="regular" className="mb-4 text-slate-400">
        Click the new workflow and you will be take to the workflow page. There
        have been no runs yet.
      </Body>
      <Body size="regular" className="mb-4 text-slate-400">
        Click the “Test” page in the left hand menu and input a valid test
        event. Remember the workflow expects a name, email and paidPlan. You can
        copy this:
      </Body>
      <CodeBlock
        code="test code"
        align="top"
        language="json"
        className="mb-4"
      />
      <Body size="regular" className="mb-4 text-slate-400">
        Hit the “Run test” button and it will take us to our first run.
      </Body>
      <Header4 size="regular" className={classNames(subTitle, "mt-8")}>
        5. The run page
      </Header4>
      <Body size="regular" className="mb-4 text-slate-400">
        All of the steps in a workflow, including the initial event, can be
        viewed in detail. You will need to refresh the page if it’s running to
        see it move between steps.
      </Body>
      <Body size="regular" className="mb-4 text-slate-400">
        But there’s a problem, we’ve used Slack in our code and we haven’t
        authenticated.
      </Body>
      <Header4 size="regular" className={classNames(subTitle, "mt-8")}>
        6. Authenticating with Slack
      </Header4>
      <Body size="regular" className="mb-4 text-slate-400">
        But there’s a problem, we’ve used Slack in our code but we haven’t
        authenticated.
      </Body>
      <Body size="regular" className="mb-4 text-slate-400">
        Simply click the “Connect to Slack” button and sign-in with your desired
        Slack workspace. As soon as you do, the workflow will pick up where it
        left off.
      </Body>
      <Body size="regular" className="mb-4 text-slate-400">
        Test complete!
      </Body>
      <Header4 size="regular" className={classNames(subTitle, "mt-8")}>
        7. Triggering this workflow from code
      </Header4>
      <Body size="regular" className="mb-4 text-slate-400">
        As this workflow uses a custom event, we need to manually trigger it
        from our code. Anywhere in your code you can do this:
      </Body>
      {/* <SubTitle>Join the community</SubTitle>
      <Panel className="max-w-4xl p-6">
        <Body className="mb-4 text-slate-300">
          To get help quickly and answers to any questions, join our Discord.
        </Body>
        <PrimaryA
          href="https://discord.gg/kA47vcd8P6"
          target="_blank"
          rel="noreferrer"
        >
          <img src={discord} alt="Discord" className="-ml-1 h-3.5" />
          <span>Join Discord</span>
        </PrimaryA>
      </Panel> */}
    </>
  );
}

const subTitle = "text-slate-200 font-semibold mb-4";
const inlineCode =
  "px-1 py-0.5 text-sm bg-slate-700 border border-slate-900 rounded text-slate-200";

function InlineCode({ children }: { children: ReactNode }) {
  return <code className={inlineCode}>{children}</code>;
}

const exampleProjects = [
  {
    icon: <StarIcon className="h-8 w-8 text-yellow-400" />,
    name: "GitHub star → Slack",
    title: "When you receive a GitHub star, post that user's details to Slack",
    description:
      "Schemas are created using Zod. In this case events must send an object that has name, email, and paidPlan.",
    requiredPackages: "@trigger.dev/slack @trigger.dev/github zod",
    code: newUserSlackMessage,
    testCode: `{
    "name": "Rick Astley",
    "email": "nevergonn@giveyou.up",
    "paidPlan": true
  }
  `,
  },
  {
    icon: <EnvelopeIcon className="h-8 w-8 text-blue-400" />,
    name: "New user → email",
    title: "When a new user signs up, send them a series of emails",
    description: "Description here",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    testCode: "",
  },
];

const fromScratchProjects = [
  {
    name: "Webhook",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
  },
  {
    name: "Custom event",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
  },
  {
    name: "Scheduled (CRON)",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
  },
];

function InstallPackages({ packages }: { packages: string }) {
  return (
    <Tab.Group>
      <UnderlinedList>
        <Underlined>npm</Underlined>
        <Underlined>pnpm</Underlined>
        <Underlined>yarn</Underlined>
      </UnderlinedList>
      <Tab.Panels className="flex-grow">
        <Tab.Panel className="relative h-full">
          <CodeBlock
            code={`npm install ${packages}`}
            language="bash"
            align="top"
            showLineNumbers={false}
          />
        </Tab.Panel>
        <Tab.Panel className="relative h-full">
          <CodeBlock
            code={`pnpm install ${packages}`}
            language="bash"
            align="top"
            showLineNumbers={false}
          />
        </Tab.Panel>
        <Tab.Panel className="relative h-full">
          <CodeBlock
            code={`yarn add ${packages}`}
            language="bash"
            align="top"
            showLineNumbers={false}
          />
        </Tab.Panel>
      </Tab.Panels>
    </Tab.Group>
  );
}
