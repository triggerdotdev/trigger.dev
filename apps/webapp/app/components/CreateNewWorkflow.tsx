import { Tab } from "@headlessui/react";
import {
  LargeBox,
  LargeBoxList,
  Underlined,
  UnderlinedList,
} from "~/components/StyledTabs";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import { PrimaryA, SecondaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { SubTitle } from "./primitives/text/SubTitle";
import { newUserSlackMessage } from "./samples/new-user-slack-message";
import CodeBlock from "./code/CodeBlock";
import { Header4 } from "./primitives/text/Headers";
import classNames from "classnames";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import invariant from "tiny-invariant";

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
      {/* <div className="mb-5 flex max-w-max items-center gap-2 rounded border border-slate-600 bg-slate-700 px-3.5 py-2">
        <InformationCircleIcon className="h-5 w-5 text-slate-300" />
        <Body>
          Trigger.dev workflows are written in your own codebase and run in your
          existing infrastructure.
        </Body>
      </div> */}
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
            {/* Example projects titles */}
            <Tab.Group>
              <LargeBoxList>
                {exampleProjects.map((project) => {
                  return <LargeBox key={project.name}>{project.name}</LargeBox>;
                })}
              </LargeBoxList>
              {/* Example projects content */}
              <Tab.Panels className="flex-grow pt-4">
                {exampleProjects.map((project) => {
                  return (
                    <Tab.Panel key={project.name} className="relative h-full">
                      <Body size="regular" className="mb-4">
                        {project.description}
                      </Body>
                      <Body size="regular" className="mb-2">
                        Install these extra API integration packages:
                      </Body>
                      <InstallPackages packages={project.requiredPackages} />
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
const allCapsTitleClasses = "mb-2 uppercase tracking-wide text-slate-400";

const exampleProjects = [
  {
    name: "GitHub star → Slack",
    requiredPackages: "@trigger.dev/slack @trigger.dev/github zod",
    code: newUserSlackMessage,
    description:
      "You’ll notice that when we subscribe to the custom event we have to say the name of the event and provide a schema. Schemas are created using Zod. In this case events must send an object that has name, email, and paidPlan.",
  },
  {
    name: "New user → email",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
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
