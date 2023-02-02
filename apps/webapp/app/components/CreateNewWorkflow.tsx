import { Tab } from "@headlessui/react";
import {
  LargeBox,
  LargeBoxList,
  Segmented,
  SegmentedList,
  Underlined,
  UnderlinedList,
} from "~/components/StyledTabs";
import {
  ArrowTopRightOnSquareIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import { PrimaryA, SecondaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { SubTitle } from "./primitives/text/SubTitle";
import { newUserSlackMessage } from "./samples/new-user-slack-message";
import { link } from "fs";

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
  return (
    <>
      <div className="mb-5 flex max-w-max items-center gap-2 rounded border border-slate-600 bg-slate-700 px-3.5 py-2">
        <InformationCircleIcon className="h-5 w-5 text-slate-300" />
        <Body>
          Trigger.dev workflows are written in your own codebase and run in your
          existing infrastructure.
        </Body>
      </div>
      <SubTitle>Step 1. Install the @trigger.dev package</SubTitle>
      <Tab.Group>
        <SegmentedList>
          <Segmented>npm</Segmented>
          <Segmented>pnpm</Segmented>
          <Segmented>yarn</Segmented>
        </SegmentedList>
        <Tab.Panels className="flex-grow pt-4">
          <Tab.Panel className="relative h-full">
            npm install @trigger.dev/sdk
          </Tab.Panel>
          <Tab.Panel className="relative h-full">
            pnpm install @trigger.dev/sdk
          </Tab.Panel>
          <Tab.Panel className="relative h-full">
            yarn add @trigger.dev/sdk
          </Tab.Panel>
        </Tab.Panels>
      </Tab.Group>
      <SubTitle>Step 2. Create your first workflow</SubTitle>
      <Tab.Group>
        <UnderlinedList>
          <Underlined>Start from an example</Underlined>
          <Underlined>Start from scratch</Underlined>
        </UnderlinedList>
        <Tab.Panels className="flex-grow pt-4">
          <Tab.Panel className="relative h-full">
            <Tab.Group>
              <LargeBoxList>
                {exampleProjects.map((project) => {
                  return <LargeBox key={project.name}>{project.name}</LargeBox>;
                })}
              </LargeBoxList>
              <Tab.Panels className="flex-grow pt-4">
                <Tab.Panel className="relative h-full">
                  New user slack message
                </Tab.Panel>
                <Tab.Panel className="relative h-full">
                  Welcome email campaign
                </Tab.Panel>
              </Tab.Panels>
            </Tab.Group>
          </Tab.Panel>
          <Tab.Panel className="relative h-full">
            <Tab.Group>
              <LargeBoxList>
                <LargeBox>Webhook</LargeBox>
                <LargeBox>Custom event</LargeBox>
                <LargeBox>Scheduled (CRON)</LargeBox>
              </LargeBoxList>
              <Tab.Panels className="flex-grow pt-4">
                <Tab.Panel className="relative h-full">Webhook</Tab.Panel>
                <Tab.Panel className="relative h-full">Custom event</Tab.Panel>
                <Tab.Panel className="relative h-full">Scheduled</Tab.Panel>
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

const allCapsTitleClasses = "mb-2 uppercase tracking-wide text-slate-400";

const exampleProjects = [
  {
    name: "Send a Slack message when a new user signs up",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
  },
  {
    name: "Welcome email campaign",
    requiredPackages: "@trigger.dev/slack zod",
    code: "new Trigger() etc...",
  },
];

const scratchProjects = [
  {
    name: "Send a Slack message when a new user signs up",
    requiredPackages: "@trigger.dev/slack zod",
    code: "code",
  },
  {
    name: "When a new user signs up, send them a series of emails",
    requiredPackages: "@trigger.dev/slack zod",
    code: "new Trigger() etc...",
  },
];
