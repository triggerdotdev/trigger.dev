import {
  ClockIcon,
  DocumentTextIcon,
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
import { formatDateTime } from "~/utils";

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
            input: {
              assignee: "samejr",
              issueId: "uiydfgydfg7yt34",
            },
            integration: "github",
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
            integration: "github",
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
            integration: "github",
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
            integration: "github",
          },
        }}
      />
      <WorkflowStep
        step={{
          type: "trigger",
          status: "inProgress",
          trigger: {
            on: "email",
            address: "james@trigger.dev",
          },
          startedAt: new Date(),
        }}
      />
      <WorkflowStep
        step={{
          type: "log",
          status: "complete",
          message: "Hello world",
          startedAt: new Date(),
          completedAt: new Date(),
        }}
      />
    </>
  );
}

const workflowNodeFlexClasses = "flex gap-1 items-baseline";
const workflowNodeUppercaseClasses = "uppercase text-slate-400";
const workflowNode1code = `{ 
  "assignee": "samejr",
  "issueId": "uiydfgydfg7yt34"
}`;

function WorkflowStep({ step }: { step: Step }) {
  return (
    <div className="flex gap-2 items-center w-full">
      <Status status={step.status} />
      <StepPanel status={step.status}>
        <StepHeader step={step} />
        <StepBody step={step} />
      </StepPanel>
    </div>
  );
}

function StepBody({ step }: { step: Step }) {
  switch (step.type) {
    case "trigger":
      switch (step.trigger.on) {
        case "webhook":
          return <Webhook webhook={step.trigger} />;
        case "email":
          // return <Email email={step.trigger.on} />;
          break;
        default:
          break;
      }
      break;
    case "log":
      return <Log log={step.message} />;
    case "delay":
    // return <Delay step={step} />;
  }

  return <></>;
}

function Webhook({ webhook }: { webhook: WebhookTrigger }) {
  return (
    <>
      <Header3 size="large" className="mb-4">
        GitHub new issue (Webhook)
      </Header3>
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Repo:
      </Body>
      <Body size="small">jsonhero-web</Body>
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Org:
      </Body>
      <Body size="small">jsonhero-web</Body>
      <CodeBlock code={JSON.stringify(webhook.input)} language="json" />
    </>
  );
}

function Log({ log }: { log: string }) {
  return (
    <Header3 size="large" className="mb-4">
      {log}
    </Header3>
  );
}

function StepHeader({ step }: { step: Step }) {
  return (
    <div className="flex mb-4 pb-3 justify-between items-center border-b border-slate-700">
      <ul className="flex gap-4 items-center">
        <li className={workflowNodeFlexClasses}>
          <StepIcon step={step} />
          <Body size="small">{stepTitle(step)}</Body>
        </li>
        {step.startedAt && (
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Start:
            </Body>
            <Body size="small">{formatDateTime(step.startedAt)}</Body>
          </li>
        )}
        {step.completedAt && (
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Completed:
            </Body>
            <Body size="small">{formatDateTime(step.completedAt)}</Body>
          </li>
        )}
      </ul>
      {step.type === "trigger" && step.trigger.on === "webhook" ? (
        <div>{step.trigger.integration}</div>
      ) : null}
    </div>
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

function stepTitle(step: Step): string {
  switch (step.type) {
    case "log":
      return "Log";
    case "delay":
      return "Delay";
    case "request":
      return "Request";
    case "trigger":
      switch (step.trigger.on) {
        case "webhook":
          return "Webhook";
        case "scheduled":
          return "Scheduled";
        case "custom":
          return "Custom";
        case "http":
          return "HTTP";
        case "aws":
          return "AWS";
        case "email":
          return "Email";
      }
  }
}

function StepIcon({ step }: { step: Step }) {
  const styleClass = "h-4 w-4 text-slate-500";
  switch (step.type) {
    case "log":
      return <DocumentTextIcon className={styleClass} />;
    case "delay":
      return <ClockIcon className={styleClass} />;
    case "request":
      return <DocumentTextIcon className={styleClass} />;
    case "trigger":
      switch (step.trigger.on) {
        case "webhook":
          return <DocumentTextIcon className={styleClass} />;
        case "scheduled":
          return <DocumentTextIcon className={styleClass} />;
        case "custom":
          return <DocumentTextIcon className={styleClass} />;
        case "http":
          return <DocumentTextIcon className={styleClass} />;
        case "aws":
          return <DocumentTextIcon className={styleClass} />;
        case "email":
          return <DocumentTextIcon className={styleClass} />;
      }
  }
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
  integration: string;
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
