import { BeakerIcon } from "@heroicons/react/20/solid";
import {
  ArrowPathIcon,
  BoltIcon,
  ChatBubbleLeftEllipsisIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  GlobeAltIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import {
  ArrowPathRoundedSquareIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  CheckCircleIcon,
  CircleStackIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/solid";
import { useFetcher } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { Delay, Scheduled } from "@trigger.dev/common-schemas";
import type { schemas as resendSchemas } from "@trigger.dev/resend/internal";
import classNames from "classnames";
import humanizeDuration from "humanize-duration";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { z } from "zod";
import CodeBlock from "~/components/code/CodeBlock";
import { EnvironmentBanner } from "~/components/EnvironmentBanner";
import { BasicConnectButton } from "~/components/integrations/ConnectButton";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryButton, TertiaryButton } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header4,
} from "~/components/primitives/text/Headers";
import { runStatusIcon, runStatusLabel } from "~/components/runs/runStatus";
import { TriggerBody } from "~/components/triggers/Trigger";
import { TriggerTypeIcon } from "~/components/triggers/TriggerIcons";
import { triggerLabel } from "~/components/triggers/triggerLabel";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import type { WorkflowRunStatus } from "~/models/workflowRun.server";
import { WorkflowRunPresenter } from "~/presenters/workflowRunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { dateDifference, formatDateTime } from "~/utils";
import { calculateDurationInMs } from "~/utils/delays";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  const { runId } = params;
  invariant(runId, "runId is required");

  const presenter = new WorkflowRunPresenter();

  try {
    const run = await presenter.data(runId);
    return typedjson({ run });
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

type Run = Awaited<ReturnType<WorkflowRunPresenter["data"]>>;
type Trigger = Run["trigger"];
type Step = Run["steps"][number];
type StepType<T, K extends Step["type"]> = T extends { type: K } ? T : never;

const timeFormatter = new Intl.DateTimeFormat("default", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

export default function Page() {
  const rerunFetcher = useFetcher();
  const { run } = useTypedLoaderData<typeof loader>();
  const output = run.steps.find((s) => s.type === "OUTPUT") as
    | StepType<Step, "OUTPUT">
    | undefined;
  const organization = useCurrentOrganization();
  invariant(organization, "organization is required");
  const workflow = useCurrentWorkflow();
  invariant(workflow, "workflow is required");

  const [lastRefreshed] = useState(new Date());

  const reload = useCallback(() => {
    document.location.reload();
  }, []);

  return (
    <>
      <EnvironmentBanner />
      <div className="sticky -top-12 z-10 -mt-4 -ml-1 flex items-center justify-between bg-slate-850 py-4 pl-1">
        <Header1 className="truncate text-slate-300">Run {run.id}</Header1>
        <div className="flex gap-2">
          {run.isTest && (
            <Body
              size="extra-small"
              className="flex items-center whitespace-nowrap rounded py-0.5 pl-2 pr-3 uppercase tracking-wide text-slate-500"
            >
              <BeakerIcon className="mr-1 h-4 w-4" />
              Test Run
            </Body>
          )}
          <rerunFetcher.Form
            action={`/resources/run/${organization.slug}/test/${workflow.slug}`}
            method="post"
          >
            <input
              type={"hidden"}
              name={"eventName"}
              value={run.trigger.eventName}
            />
            <input
              type={"hidden"}
              name={"payload"}
              value={JSON.stringify(run.trigger.input)}
            />
            <PrimaryButton
              type="submit"
              name="source"
              value="rerun"
              onClick={(e) => {
                if (
                  !confirm(
                    "Are you sure you want to create a new run with the same payload?"
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              <ArrowPathRoundedSquareIcon className="-ml-1 h-5 w-5" />
              Rerun
            </PrimaryButton>
          </rerunFetcher.Form>
        </div>
      </div>

      <ul className="ml-[-3px] flex flex-wrap gap-6">
        <li className="flex items-center gap-2">
          {runStatusIcon(run.status, "large")}
          <Header2 size="small" className="text-slate-400">
            {runStatusLabel(run.status)}
          </Header2>
        </li>
        <li className="flex items-center gap-1">
          <Header2 size="small" className="text-slate-400">
            {run.startedAt &&
              `Started: ${formatDateTime(run.startedAt, "long")}`}
          </Header2>
        </li>
        {run.duration && (
          <li className="flex items-center gap-1">
            <Header2 size="small" className="text-slate-400">
              Duration: {humanizeDuration(run.duration)}
            </Header2>
          </li>
        )}
      </ul>

      <TriggerStep trigger={run.trigger} />

      {run.steps
        .filter((s) => s.type !== "OUTPUT")
        .map((step, index) => (
          <WorkflowStep key={index} step={step} />
        ))}

      {run.status === "SUCCESS" && (
        <>
          <div className="ml-[10px] -mr-[10px] h-3 w-full border-l border-slate-700"></div>
          <Panel>
            <PanelHeader
              icon={<CheckCircleIcon className="h-6 w-6 text-green-500" />}
              title="Run complete"
              runId={run.id}
            />
            <div className="grid grid-cols-3 gap-2 text-slate-300">
              <div className="flex flex-col gap-1">
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  Run duration
                </Body>
                <Body className={workflowNodeDelayClasses} size="small">
                  {run.duration && humanizeDuration(run.duration)}
                </Body>
              </div>
              <div className="flex flex-col gap-1">
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  Started
                </Body>
                <Body className={workflowNodeDelayClasses} size="small">
                  {run.startedAt && formatDateTime(run.startedAt, "long")}
                </Body>
              </div>
              <div className="flex flex-col gap-1">
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  Completed
                </Body>
                <Body className={workflowNodeDelayClasses} size="small">
                  {run.finishedAt && formatDateTime(run.finishedAt, "long")}
                </Body>
              </div>
            </div>
            {output && (
              <CodeBlock
                code={stringifyCode(output.output)}
                language="json"
                className="mt-2"
                align="top"
                maxHeight="150px"
              />
            )}
          </Panel>
        </>
      )}

      {run.status === "RUNNING" && (
        <div className="flex w-full items-stretch">
          <div className="relative ml-2.5 flex w-5 border-l border-dashed border-slate-700">
            <div className="absolute top-[13px] -left-[13px] rounded-full bg-slate-850 p-1">
              {runStatusIcon("RUNNING", "small")}
            </div>
          </div>

          <Body
            size="small"
            className={classNames("my-4 ml-0 font-mono text-slate-400")}
          >
            <span className="flex items-center gap-2">
              Last refreshed {timeFormatter.format(lastRefreshed)}.{" "}
              <TertiaryButton
                onClick={() => reload()}
                className="underline decoration-green-500 underline-offset-4"
              >
                <ArrowPathIcon className="h-4 w-4 text-slate-400" />
                Refresh
              </TertiaryButton>
            </span>
          </Body>
        </div>
      )}

      {run.status === "TIMED_OUT" && (
        <>
          <div className="ml-[10px] -mr-[10px] h-3 w-full border-l border-slate-700"></div>
          <Panel>
            <PanelHeader
              icon={
                <ExclamationTriangleIcon className="h-6 w-6 text-amber-300" />
              }
              title="Run timed out"
              runId={run.id}
            />
            <div className="flex flex-col gap-1 text-slate-300">
              <Body size="extra-small" className={workflowNodeUppercaseClasses}>
                Reason
              </Body>
              <Body className={workflowNodeDelayClasses} size="small">
                {run.timedOutReason}
              </Body>
            </div>
          </Panel>
        </>
      )}

      {run.error && <Error error={run.error} />}
    </>
  );
}

function stringifyCode(obj: any) {
  return JSON.stringify(obj, null, 2);
}

const workflowNodeUppercaseClasses = "uppercase text-slate-400 tracking-wider";
const workflowNodeDelayClasses =
  "flex rounded-md bg-[#0F172A] pl-4 p-3 font-mono";

function TriggerStep({ trigger }: { trigger: Trigger }) {
  const { run } = useTypedLoaderData<typeof loader>();
  const [lastRefreshed] = useState(new Date());

  const reload = useCallback(() => {
    document.location.reload();
  }, []);

  return (
    <>
      <Panel className="mt-4">
        <PanelHeader
          icon={
            <div className="mr-1 h-6 w-6">
              <TriggerTypeIcon
                type={trigger.type}
                provider={trigger.integration}
              />
            </div>
          }
          title={triggerLabel(trigger.type)}
          startedAt={trigger.startedAt}
          finishedAt={null}
          // name="Initial wait"
          // integration={trigger.type === "WEBHOOK"}
        />
        <TriggerBody trigger={trigger} />
        {trigger.input && (
          <CodeBlock
            code={stringifyCode(trigger.input)}
            align="top"
            maxHeight="150px"
            className="mt-2"
          />
        )}
      </Panel>
      {run.status === "PENDING" && (
        <div className="flex w-full items-stretch">
          <div className="relative ml-2.5 flex w-5 border-l border-dashed border-slate-700">
            <div className="absolute top-[13px] -left-[13px] rounded-full bg-slate-850 p-1">
              {runStatusIcon("RUNNING", "small")}
            </div>
          </div>

          <Body
            size="small"
            className={classNames("my-4 ml-0 font-mono text-slate-400")}
          >
            <span className="flex items-center gap-2">
              Last refreshed {timeFormatter.format(lastRefreshed)}.{" "}
              <TertiaryButton
                onClick={() => reload()}
                className="underline decoration-green-500 underline-offset-4"
              >
                <ArrowPathIcon className="h-4 w-4 text-slate-400" />
                Refresh
              </TertiaryButton>
            </span>
          </Body>
        </div>
      )}
    </>
  );
}

function WorkflowStep({ step }: { step: Step }) {
  const [showCodeBlock, setShowCodeBlock] = useState(false);
  const toggleCodeBlock = () => {
    setShowCodeBlock(!showCodeBlock);
  };
  switch (step.type) {
    case "DISCONNECTION":
      return (
        <div className="flex w-full items-stretch">
          <div className="relative ml-2.5 flex w-5 border-l border-dashed border-slate-700">
            <div className="absolute top-2 -left-[18px] rounded-full bg-slate-850 p-1">
              {runStatusIcon("DISCONNECTED", "large")}
            </div>
          </div>

          <Body
            size="small"
            className={classNames("my-4 ml-0.5 font-mono text-slate-400")}
          >
            {step.startedAt && step.finishedAt
              ? `The run disconnected for ${humanizeDuration(
                  dateDifference(step.startedAt, step.finishedAt),
                  { round: true }
                )} here.`
              : step.startedAt
              ? `The run disconnected on ${formatDateTime(
                  step.startedAt,
                  "long"
                )}.`
              : "Disconnected"}
          </Body>
        </div>
      );
    case "LOG_MESSAGE":
      return (
        <div className="flex w-full items-stretch">
          <div className="relative ml-2.5 flex w-5 shrink-0 border-l border-slate-700">
            <div className="absolute top-2 -left-[18px] rounded-full bg-slate-850 p-1">
              <ChatBubbleOvalLeftEllipsisIcon
                className={classNames("h-7 w-7", logColor[step.input.level])}
              />
            </div>
          </div>
          <div className="my-4 flex w-full flex-col gap-2">
            <div className={classNames("flex items-center gap-2")}>
              <Body
                size="small"
                className={classNames(
                  "ml-1 font-mono",
                  logColor[step.input.level]
                )}
              >
                {step.input.message}
              </Body>

              {step.input.properties &&
                Object.keys(step.input.properties).length !== 0 && (
                  <button
                    onClick={toggleCodeBlock}
                    className="text-sm text-slate-400 transition hover:text-slate-200"
                  >
                    {showCodeBlock ? (
                      <span className="flex items-center gap-1">
                        Hide custom fields <ChevronUpIcon className="h-4 w-4" />
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        View custom fields{" "}
                        <ChevronDownIcon className="h-4 w-4" />
                      </span>
                    )}
                  </button>
                )}
            </div>

            {step.input.properties &&
              Object.keys(step.input.properties).length !== 0 &&
              showCodeBlock && (
                <CodeBlock
                  code={stringifyCode(step.input.properties)}
                  align="top"
                  maxHeight="150px"
                />
              )}
          </div>
        </div>
      );
    default:
      return (
        <div className="flex w-full items-stretch">
          <div className="relative ml-2.5 flex w-5 shrink-0 border-l border-slate-700">
            <div className="absolute top-[23px] -left-[18px] rounded-full bg-slate-850 p-1">
              {runStatusIcon(step.status, "large")}
            </div>
          </div>
          <StepPanel status={step.status}>
            <StepHeader step={step} />
            <StepBody step={step} />
          </StepPanel>
        </div>
      );
  }
}

function StepPanel({
  status,
  children,
}: {
  status: WorkflowRunStatus;
  children: ReactNode;
}) {
  let borderClass = "border-slate-800";
  switch (status) {
    case "ERROR":
      borderClass = "border-rose-700";
      break;
    case "RUNNING":
      borderClass = "border-blue-700";
      break;
  }

  return <Panel className={`border ${borderClass} my-4`}>{children}</Panel>;
}

function StepHeader({ step }: { step: Step }) {
  switch (step.type) {
    case "INTEGRATION_REQUEST":
      return (
        <PanelHeader
          icon={
            <img
              src={step.service.integration.icon}
              alt={step.service.integration.name}
              className="mr-1 h-5 w-5"
            />
          }
          title={step.service.integration.name}
          startedAt={step.startedAt}
          finishedAt={step.finishedAt}
          integration={step.service.connection?.title}
        />
      );
    case "FETCH_REQUEST":
      return (
        <PanelHeader
          icon={stepInfo[step.type].icon}
          title={step.title}
          startedAt={step.startedAt}
          finishedAt={step.finishedAt}
        />
      );
    default:
      return (
        <PanelHeader
          icon={stepInfo[step.type].icon}
          title={stepInfo[step.type].label}
          startedAt={step.startedAt}
          finishedAt={step.finishedAt}
        />
      );
  }
}

function InputTitle() {
  return (
    <Body size="extra-small" className={`mb-1 ${workflowNodeUppercaseClasses}`}>
      Input
    </Body>
  );
}

function OutputTitle() {
  return (
    <Body size="extra-small" className={`mb-1 ${workflowNodeUppercaseClasses}`}>
      Output
    </Body>
  );
}

function StepBody({ step }: { step: Step }) {
  switch (step.type) {
    case "CUSTOM_EVENT":
      return <CustomEventStep event={step} />;
    case "RUN_ONCE":
      return <RunOnceStep event={step} />;
    case "INTEGRATION_REQUEST":
      return <IntegrationRequestStep request={step} />;
    case "FETCH_REQUEST":
      return <FetchRequestStep request={step} />;
    case "DURABLE_DELAY":
      return <DelayStep step={step} />;
    case "KV_GET":
      return <KVGetStep step={step} />;
    case "KV_SET":
      return <KVSetStep step={step} />;
    case "KV_DELETE":
      return <KVDeleteStep step={step} />;
  }
  return <></>;
}

function DelayStep({ step }: { step: StepType<Step, "DURABLE_DELAY"> }) {
  switch (step.input.type) {
    case "DELAY":
      return <DelayDuration step={step} delay={step.input} />;
    case "SCHEDULE_FOR":
      return <DelayScheduled step={step} scheduled={step.input} />;
  }
}

function DelayDuration({
  step,
  delay,
}: {
  step: StepType<Step, "DURABLE_DELAY">;
  delay: Delay;
}) {
  const msDelay = calculateDurationInMs(delay);
  const [timeRemaining, setTimeRemaining] = useState(
    step.startedAt
      ? msDelay - dateDifference(step.startedAt, new Date())
      : undefined
  );

  useEffect(() => {
    if (timeRemaining === undefined) return;
    const interval = setInterval(() => {
      setTimeRemaining((timeRemaining) => {
        if (timeRemaining === undefined) return undefined;
        if (timeRemaining <= 1000) return 0;
        if (timeRemaining <= 0) {
          clearInterval(interval);
          return 0;
        }

        return timeRemaining - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeRemaining]);

  return (
    <div className="grid grid-cols-2 gap-2 text-slate-300">
      <div className="flex flex-col gap-1">
        <Body size="extra-small" className={workflowNodeUppercaseClasses}>
          Total delay
        </Body>
        <Body
          className={classNames(workflowNodeDelayClasses, "w-full")}
          size="small"
        >
          {humanizeDuration(msDelay)}
        </Body>
      </div>
      {step.status === "RUNNING" && timeRemaining && (
        <div className="flex flex-col gap-1">
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Fires in
          </Body>
          <Body
            className={classNames(workflowNodeDelayClasses, "w-full")}
            size="small"
          >
            {humanizeDuration(timeRemaining, { round: true })}
          </Body>
        </div>
      )}
    </div>
  );
}

function DelayScheduled({
  step,
  scheduled,
}: {
  step: StepType<Step, "DURABLE_DELAY">;
  scheduled: Scheduled;
}) {
  const scheduledDate = new Date(scheduled.scheduledFor);
  const [timeRemaining, setTimeRemaining] = useState(
    scheduledDate ? dateDifference(new Date(), scheduledDate) : undefined
  );

  useEffect(() => {
    if (timeRemaining === undefined) return;
    const interval = setInterval(() => {
      setTimeRemaining((timeRemaining) => {
        if (timeRemaining === undefined) return undefined;
        if (timeRemaining <= 1000) return undefined;
        if (timeRemaining <= 0) {
          clearInterval(interval);
          return undefined;
        }

        return timeRemaining - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeRemaining]);

  return (
    <div className="grid grid-cols-2 gap-2 text-slate-300">
      <div className="flex flex-col items-stretch gap-1">
        <Body size="extra-small" className={workflowNodeUppercaseClasses}>
          Fires at
        </Body>
        <Body
          className={classNames(workflowNodeDelayClasses, "font-mono")}
          size="small"
        >
          {formatDateTime(scheduledDate, "long")}
        </Body>
      </div>
      {step.status === "RUNNING" && timeRemaining && (
        <div className="flex flex-col gap-1">
          <Body
            size="extra-small"
            className={classNames(workflowNodeUppercaseClasses)}
          >
            Fires in
          </Body>
          <Body
            className={classNames(workflowNodeDelayClasses, "font-mono")}
            size="small"
          >
            {humanizeDuration(timeRemaining, { round: true })}
          </Body>
        </div>
      )}
    </div>
  );
}

function CustomEventStep({ event }: { event: StepType<Step, "CUSTOM_EVENT"> }) {
  return (
    <>
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Name
      </Body>
      <Header2 size="small" className="mb-2 text-slate-300">
        {event.input.name}
      </Header2>
      {"delay" in event.input && event.input.delay && (
        <>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Delay
          </Body>
          <Body size="small" className="mb-2 text-slate-300">
            {"seconds" in event.input.delay ? (
              <>
                {event.input.delay.seconds}{" "}
                {event.input.delay.seconds > 1 ? "seconds" : "second"}
              </>
            ) : "minutes" in event.input.delay ? (
              <>
                {event.input.delay.minutes}{" "}
                {event.input.delay.minutes > 1 ? "minutes" : "minute"}
              </>
            ) : "hours" in event.input.delay ? (
              <>
                {event.input.delay.hours}{" "}
                {event.input.delay.hours > 1 ? "hours" : "hour"}
              </>
            ) : "days" in event.input.delay ? (
              <>
                {event.input.delay.days}{" "}
                {event.input.delay.days > 1 ? "days" : "day"}
              </>
            ) : "until" in event.input.delay ? (
              <>Until {event.input.delay.until}</>
            ) : (
              <></>
            )}
          </Body>
        </>
      )}
      <Header4>Payload</Header4>
      <CodeBlock code={stringifyCode(event.input.payload)} align="top" />
      {event.input.context && (
        <>
          <Header4>Context</Header4>
          <CodeBlock code={stringifyCode(event.input.context)} align="top" />
        </>
      )}
    </>
  );
}

function KVGetStep({ step }: { step: StepType<Step, "KV_GET"> }) {
  const scope = step.input.namespace.split(":")[0];

  return (
    <>
      <div className="flex gap-16">
        <div>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Key
          </Body>
          <Header2 size="small" className="mb-2 text-slate-300">
            {step.input.key}
          </Header2>
        </div>

        <div>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Scope
          </Body>
          <Header2 size="small" className="mb-2 text-slate-300">
            {scope}
          </Header2>
        </div>
      </div>

      {step.output && (
        <>
          <Header4>Output</Header4>
          <CodeBlock
            code={stringifyCode(step.output)}
            align="top"
            maxHeight="200px"
          />
        </>
      )}
    </>
  );
}

function KVSetStep({ step }: { step: StepType<Step, "KV_SET"> }) {
  const scope = step.input.namespace.split(":")[0];

  return (
    <>
      <div className="flex gap-16">
        <div>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Key
          </Body>
          <Header2 size="small" className="mb-2 text-slate-300">
            {step.input.key}
          </Header2>
        </div>

        <div>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Scope
          </Body>
          <Header2 size="small" className="mb-2 text-slate-300">
            {scope}
          </Header2>
        </div>
      </div>

      {step.input.value && (
        <>
          <Header4>Value</Header4>
          <CodeBlock
            code={stringifyCode(step.input.value)}
            align="top"
            maxHeight="200px"
          />
        </>
      )}
    </>
  );
}

function KVDeleteStep({ step }: { step: StepType<Step, "KV_DELETE"> }) {
  const scope = step.input.namespace.split(":")[0];

  return (
    <>
      <div className="flex gap-16">
        <div>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Key
          </Body>
          <Header2 size="small" className="mb-2 text-slate-300">
            {step.input.key}
          </Header2>
        </div>

        <div>
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Scope
          </Body>
          <Header2 size="small" className="mb-2 text-slate-300">
            {scope}
          </Header2>
        </div>
      </div>
    </>
  );
}

function RunOnceStep({ event }: { event: StepType<Step, "RUN_ONCE"> }) {
  return (
    <>
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Idempotency Key
      </Body>
      <Header2 size="small" className="mb-2 text-slate-300">
        {event.idempotencyKey}
      </Header2>
      {event.output && (
        <>
          <Header4>Output</Header4>
          <CodeBlock code={stringifyCode(event.output)} align="top" />
        </>
      )}
    </>
  );
}

function IntegrationRequestStep({
  request,
}: {
  request: StepType<Step, "INTEGRATION_REQUEST">;
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be set");

  const component = request.customComponent
    ? renderCustomComponent(request.customComponent)
    : null;

  return (
    <>
      <Header2 size="small" className="mb-2 text-slate-300">
        {request.displayProperties.title}
      </Header2>
      {request.service.connection === null && (
        <>
          <div className="mb-2 flex items-center gap-2 rounded-md border border-rose-600 bg-rose-500/10 p-3">
            <ExclamationCircleIcon className="mr-1 h-6 w-6 text-rose-500" />
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <Body>
                You need to connect to {request.service.integration.name} to
                continue this workflow.
              </Body>
              <BasicConnectButton
                key={request.service.slug}
                integration={request.service.integration}
                organizationId={organization.id}
                serviceId={request.service.id}
              />
            </div>
          </div>
        </>
      )}

      <div className="mt-4">
        {request.input && (
          <>
            <InputTitle />
            <CodeBlock
              code={stringifyCode(request.input)}
              align="top"
              maxHeight="200px"
            />
          </>
        )}
      </div>

      <div className="mt-4">
        {request.requestStatus === "ERROR" ? (
          <div>
            <div className="mb-2 mt-3 flex gap-2 ">
              <ExclamationTriangleIcon className="h-5 w-5 text-rose-500" />
              <Body size="small" className="text-rose-500">
                {request.service.integration.name} responded with error:
              </Body>
            </div>
            <CodeBlock
              code={request.output ? stringifyCode(request.output) : ""}
              align="top"
              maxHeight="200px"
              className="border border-rose-500"
            />
          </div>
        ) : (
          request.output && (
            <>
              <div className="flex justify-between">
                <OutputTitle />
                {request.retryCount > 0 && (
                  <Body size="small" className="text-slate-400">
                    {request.retryCount} retries
                  </Body>
                )}
              </div>
              <CodeBlock
                code={stringifyCode(request.output)}
                align="top"
                maxHeight="200px"
              />
            </>
          )
        )}
      </div>
      {request.status === "SUCCESS" && component !== null && (
        <>
          <Body
            size="extra-small"
            className={`mt-4 mb-1 ${workflowNodeUppercaseClasses}`}
          >
            Preview
          </Body>
          <div>{component}</div>
        </>
      )}
    </>
  );
}

function FetchRequestStep({
  request,
}: {
  request: StepType<Step, "FETCH_REQUEST">;
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be set");

  return (
    <>
      <div className="mt-4">
        {request.input && (
          <>
            <InputTitle />
            <CodeBlock code={stringifyCode(request.input)} align="top" />
          </>
        )}
      </div>

      <div className="mt-4">
        {request.requestStatus === "ERROR" ? (
          <div>
            <div className="mb-2 mt-3 flex gap-2 ">
              <ExclamationTriangleIcon className="h-5 w-5 text-rose-500" />
              <Body size="small" className="text-rose-500">
                Failed with error:
              </Body>
            </div>
            <CodeBlock
              code={request.output ? stringifyCode(request.output) : ""}
              align="top"
              maxHeight="200px"
              className="border border-rose-500"
            />
          </div>
        ) : request.requestStatus === "RETRYING" ? (
          <div>
            <div className="mb-2 mt-3 flex gap-2 ">
              <ExclamationTriangleIcon className="h-5 w-5 text-rose-500" />
              <Body size="small" className="text-rose-500">
                {request.lastResponse ? (
                  <>Got a {request.lastResponse.status} response, retrying...</>
                ) : (
                  <>Retrying...</>
                )}
              </Body>
            </div>
            {request.output ? (
              <CodeBlock
                code={request.output ? stringifyCode(request.output) : ""}
                align="top"
                maxHeight="200px"
                className="border border-rose-500"
              />
            ) : null}
          </div>
        ) : (
          request.output && (
            <>
              <div className="flex justify-between">
                <OutputTitle />
                {request.retryCount > 0 && (
                  <Body size="small" className="text-slate-400">
                    {request.retryCount} retries
                  </Body>
                )}
              </div>
              <CodeBlock
                code={stringifyCode(request.output)}
                align="top"
                maxHeight="200px"
              />
            </>
          )
        )}
      </div>
    </>
  );
}

function Error({ error }: { error: Run["error"] }) {
  if (!error) return null;

  return (
    <>
      <div className="mb-2 mt-3 flex gap-2 ">
        <ExclamationTriangleIcon className="h-5 w-5 text-rose-500" />
        <Body size="small" className="text-slate-300">
          Failed with error:
        </Body>
      </div>
      <Panel className="border border-rose-600">
        <Header4 className="font-mono">
          {error.name}: {error.message}
        </Header4>
        {error.stackTrace && (
          <div className="mt-2">
            <CodeBlock code={error.stackTrace} language="json" align="top" />
          </div>
        )}
      </Panel>
    </>
  );
}

const styleClass = "h-6 w-6 text-slate-400";
const stepInfo: Record<Step["type"], { label: string; icon: ReactNode }> = {
  LOG_MESSAGE: {
    label: "Log",
    icon: <ChatBubbleLeftEllipsisIcon className={styleClass} />,
  },
  CUSTOM_EVENT: {
    label: "Fire custom event",
    icon: <BoltIcon className={styleClass} />,
  },
  OUTPUT: { label: "Output", icon: <></> },
  INTEGRATION_REQUEST: {
    label: "API request",
    icon: <GlobeAltIcon className={styleClass} />,
  },
  DURABLE_DELAY: {
    label: "Delay",
    icon: <ClockIcon className={styleClass} />,
  },
  DISCONNECTION: {
    label: "Disconnected",
    icon: <ExclamationCircleIcon className={styleClass} />,
  },
  FETCH_REQUEST: {
    label: "Fetch request",
    icon: <GlobeAltIcon className={styleClass} />,
  },
  RUN_ONCE: {
    label: "Run once",
    icon: <KeyIcon className={styleClass} />,
  },
  KV_GET: {
    label: "Get Key Value",
    icon: <CircleStackIcon className={styleClass} />,
  },
  KV_SET: {
    label: "Set Key Value",
    icon: <CircleStackIcon className={styleClass} />,
  },
  KV_DELETE: {
    label: "Delete Key Value",
    icon: <CircleStackIcon className={styleClass} />,
  },
} as const;

type LogLevel = StepType<Step, "LOG_MESSAGE">["input"]["level"];
const logColor: Record<LogLevel, string> = {
  INFO: "text-slate-400",
  WARN: "text-amber-300",
  ERROR: "text-rose-400",
  DEBUG: "text-slate-400",
} as const;

function renderCustomComponent({
  component,
  input,
}: {
  component: "resend";
  input: z.infer<typeof resendSchemas.SendEmailBodySchema>;
}) {
  return (
    <div className="rounded-md bg-white">
      <div className="flex h-8 items-center rounded-t-md bg-slate-100 px-2">
        <div className="flex h-8 items-center gap-2 rounded-t-md bg-slate-100">
          <div className="h-3 w-3 rounded-full bg-rose-500"></div>
          <div className="h-3 w-3 rounded-full bg-orange-500"></div>
          <div className="h-3 w-3 rounded-full bg-emerald-500"></div>
        </div>
      </div>
      <div className="border-b border-slate-300 px-4 py-2">
        <h2 className="text-lg font-bold text-slate-600">{input.from}</h2>
        <h2 className="text-slate-600">{input.subject}</h2>
        <div className="flex gap-2">
          <EmailInfo label="to" value={input.to} />
          <EmailInfo label="cc" value={input.cc} />
          <EmailInfo label="bcc" value={input.bcc} />
        </div>
        <div className="flex gap-2">
          <EmailInfo label="reply to" value={input.reply_to} />
        </div>
      </div>
      <div className="px-4 text-slate-600">
        {input.html && (
          <div
            dangerouslySetInnerHTML={{
              __html: input.html,
            }}
          />
        )}
        {input.text && <div className="py-4 text-slate-600">{input.text}</div>}
      </div>
    </div>
  );
}
function EmailInfo({
  label,
  value,
}: {
  label: string;
  value?: string | string[];
}) {
  if (!value) {
    return null;
  }

  return (
    <div className="flex items-baseline gap-2 text-sm text-slate-500">
      <h3 className="text-slate-400">{label}:</h3>
      {typeof value === "string" ? value : value.join(", ")}
    </div>
  );
}
