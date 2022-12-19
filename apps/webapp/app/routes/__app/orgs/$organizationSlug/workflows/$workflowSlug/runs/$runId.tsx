import {
  ClockIcon,
  PlayCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import {
  ArrowPathRoundedSquareIcon,
  BeakerIcon,
} from "@heroicons/react/24/solid";
import { Panel } from "~/components/layout/Panel";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Select } from "~/components/primitives/Select";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
import CodeBlock from "~/components/code/CodeBlock";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { WorkflowNodeArrow } from "~/components/WorkflowNodeArrow";
import type { ReactNode } from "react";

export default function Page() {
  return (
    <>
      <div className="flex sticky -top-12 py-4 bg-slate-850 justify-between items-center z-10">
        <Header1 className="">Run #1</Header1>
        <div className="flex gap-2">
          <Body
            size="extra-small"
            className="flex items-center pl-2 pr-3 py-0.5 rounded uppercase tracking-wide text-slate-500"
          >
            <BeakerIcon className="h-4 w-4 mr-1" />
            Test Run
          </Body>
          <PrimaryButton>
            <ArrowPathRoundedSquareIcon className="h-5 w-5 -ml-1" />
            Rerun
          </PrimaryButton>
        </div>
      </div>

      <ul className="flex gap-6 mb-4">
        <li className="flex gap-2 items-center">
          <Spinner />
          <Header2 size="small" className="text-slate-400">
            In progress
          </Header2>
        </li>
        <li className="flex gap-1 items-center">
          <PlayCircleIcon className="h-5 w-5 text-slate-400" />
          <Header2 size="small" className="text-slate-400">
            Started: 12:34:56pm Dec 13, 2022
          </Header2>
        </li>
        <li className="flex gap-1 items-center">
          <ClockIcon className="h-5 w-5 text-slate-400" />
          <Header2 size="small" className="text-slate-400">
            Duration: 1m 23s
          </Header2>
        </li>
      </ul>

      <WorkflowStep
        step={{
          type: "trigger",
          status: "complete",
          trigger: {
            on: "webhook",
            input: {},
          },
          startedAt: new Date(),
          completedAt: new Date(),
        }}
      />
      <WorkflowNodeArrow />
      <WorkflowStep
        step={{
          type: "trigger",
          status: "error",
          trigger: {
            on: "webhook",
            input: {},
          },
          startedAt: new Date(),
          completedAt: new Date(),
        }}
      />
      <WorkflowNodeArrow />
      <WorkflowStep
        step={{
          type: "trigger",
          status: "inProgress",
          trigger: {
            on: "webhook",
            input: {},
          },
          startedAt: new Date(),
        }}
      />
      <WorkflowNodeArrow />
      <WorkflowStep
        step={{
          type: "trigger",
          status: "notStarted",
          trigger: {
            on: "webhook",
            input: {},
          },
        }}
      />
    </>
  );
}

function WorkflowStep({ step }: { step: Step }) {
  const workflowNodeFlexClasses = "flex gap-1 items-baseline";
  const workflowNodeUppercaseClasses = "uppercase text-slate-400";
  const workflowNode1code = `{ 
  "assignee": "samejr",
  "issueId": "uiydfgydfg7yt34"
}`;

  return (
    <StepPanel status={step.status}>
      <div className="flex mb-4 pb-3 justify-between items-center border-b border-slate-700">
        <ul className="flex gap-4 items-center">
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Type:
            </Body>
            <Body size="small">Trigger</Body>
          </li>
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Step:
            </Body>
            <div className="flex gap-0.5 items-baseline">
              <Status status={step.status} />
              <Body size="small">{step.status}</Body>
            </div>
          </li>
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Org:
            </Body>
            <Body size="small">apihero-run</Body>
          </li>
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Repo:
            </Body>
            <Body size="small">jsonhero-web</Body>
          </li>
        </ul>
        <Select>
          <option value="GitHub #1">GitHub #1</option>
          <option value="GitHub #2">GitHub #2</option>
          <option value="GitHub #3">GitHub #3</option>
        </Select>
      </div>
      <Header3 size="large" className="mb-4">
        GitHub new issue (Webhook)
      </Header3>
      <CodeBlock code={workflowNode1code} language="json" />
    </StepPanel>
  );
}

function Status({ status }: { status: WorkflowStepStatus }) {
  switch (status) {
    case "error":
      return (
        <XCircleIcon className="relative top-[3px] h-4 w-4 text-red-500" />
      );
    case "inProgress":
      return <Spinner className="relative top-[3px] h-4 w-4 text-blue-500" />;
    case "complete":
      return (
        <CheckCircleIcon className="relative top-[3px] h-4 w-4 text-green-500" />
      );
    default:
      return (
        <ClockIcon className="relative top-[3px] h-4 w-4 text-slate-500" />
      );
  }
}

function StepPanel({
  status,
  children,
}: {
  status: WorkflowStepStatus;
  children: ReactNode;
}) {
  let borderClass = "border-slate-800";
  switch (status) {
    case "error":
      borderClass = "border-red-700";
      break;
    case "inProgress":
      borderClass = "border-blue-700";
      break;
  }

  return <Panel className={`border ${borderClass}`}>{children}</Panel>;
}

type Step = LogStep | DelayStep | RequestStep | TriggerStep;

type TriggerStep = CommonStepData & {
  type: "trigger";
  trigger:
    | WebhookTrigger
    | ScheduledTrigger
    | CustomTrigger
    | HttpTrigger
    | AwsTrigger
    | EmailTrigger;
};

type LogStep = CommonStepData & {
  type: "log";
  message: string;
};

type DelayStep = CommonStepData & {
  type: "delay";
  duration: number;
};

type RequestStep = CommonStepData & {
  type: "request";
  integration: string;
};

type WebhookTrigger = {
  on: "webhook";
  input: any;
};

type ScheduledTrigger = {
  on: "scheduled";
  input: any;
};

type CustomTrigger = {
  on: "custom";
  name: string;
  input: any;
};

type HttpTrigger = {
  on: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
};

type EmailTrigger = {
  on: "email";
  address: string;
};

type AwsTrigger = {
  on: "aws";
  input: any;
};

type CommonStepData = {
  status: WorkflowStepStatus;
  startedAt?: Date;
  completedAt?: Date;
};

type WorkflowStepStatus = "error" | "inProgress" | "complete" | "notStarted";
