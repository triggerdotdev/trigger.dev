import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BeakerIcon, RectangleStackIcon } from "@heroicons/react/20/solid";
import { type ActionFunction, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { DateField } from "~/components/primitives/DateField";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { DurationPicker } from "~/components/primitives/DurationPicker";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Select, SelectItem } from "~/components/primitives/Select";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { TimezoneList } from "~/components/scheduled/timezones";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useParams, Form, useActionData, useFetcher } from "@remix-run/react";
import {
  redirectBackWithErrorMessage,
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ScheduledRun,
  type StandardRun,
  type StandardTaskResult,
  type ScheduledTaskResult,
  TestTaskPresenter,
} from "~/presenters/v3/TestTaskPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { docsPath, v3RunSpanPath, v3TaskParamsSchema, v3TestPath } from "~/utils/pathBuilder";
import { TestTaskService } from "~/v3/services/testTask.server";
import { OutOfEntitlementError } from "~/v3/services/triggerTask.server";
import { TestTaskData } from "~/v3/testTask";
import { RunTagInput } from "~/components/runs/v3/RunTagInput";
import { type loader as queuesLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues";
import { DateTime } from "~/components/primitives/DateTime";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import { MachinePresetName } from "@trigger.dev/core/v3";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, taskParam } = v3TaskParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new TestTaskPresenter();
  try {
    const result = await presenter.call({
      userId,
      projectId: project.id,
      taskIdentifier: taskParam,
      environment: environment,
    });

    return typedjson(result);
  } catch (error) {
    return redirectWithErrorMessage(
      v3TestPath({ slug: organizationSlug }, { slug: projectParam }, environment),
      request,
      `Couldn't load test page for ${taskParam}`
    );
  }
};

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, taskParam } = v3TaskParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: TestTaskData });

  if (!submission.value) {
    return json(submission);
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectBackWithErrorMessage(request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);

  if (!environment) {
    return redirectBackWithErrorMessage(request, "Environment not found");
  }

  if (environment.archivedAt) {
    return redirectBackWithErrorMessage(request, "Can't run a test on an archived environment");
  }

  const testService = new TestTaskService();
  try {
    const run = await testService.call(environment, submission.value);

    if (!run) {
      return redirectBackWithErrorMessage(
        request,
        "Unable to start a test run: Something went wrong"
      );
    }

    return redirectWithSuccessMessage(
      v3RunSpanPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: run.friendlyId },
        { spanId: run.spanId }
      ),
      request,
      "Test run created"
    );
  } catch (e) {
    if (e instanceof OutOfEntitlementError) {
      return redirectBackWithErrorMessage(
        request,
        "Unable to start a test run: You have exceeded your free credits"
      );
    }

    logger.error("Failed to start a test run", { error: e instanceof Error ? e.message : e });

    return redirectBackWithErrorMessage(
      request,
      "Unable to start a test run: Something went wrong"
    );
  }
};

export default function Page() {
  const result = useTypedLoaderData<typeof loader>();

  if (!result.foundTask) {
    return <div></div>;
  }

  const params = useParams();
  const queueFetcher = useFetcher<typeof queuesLoader>();

  useEffect(() => {
    if (params.organizationSlug && params.projectParam && params.envParam) {
      const searchParams = new URLSearchParams();
      searchParams.set("type", "custom");
      searchParams.set("per_page", "100");

      queueFetcher.load(
        `/resources/orgs/${params.organizationSlug}/projects/${params.projectParam}/env/${
          params.envParam
        }/queues?${searchParams.toString()}`
      );
    }
  }, [params.organizationSlug, params.projectParam, params.envParam]);

  const defaultTaskQueue = result.queue;
  const queues = useMemo(() => {
    const customQueues = queueFetcher.data?.queues ?? [];

    return defaultTaskQueue && !customQueues.some((q) => q.id === defaultTaskQueue.id)
      ? [defaultTaskQueue, ...customQueues]
      : customQueues;
  }, [queueFetcher.data?.queues, defaultTaskQueue]);

  const { triggerSource } = result;
  switch (triggerSource) {
    case "STANDARD": {
      return (
        <StandardTaskForm
          task={result.task}
          queues={queues}
          runs={result.runs}
          versions={result.latestVersions}
          disableVersionSelection={result.disableVersionSelection}
          allowArbitraryQueues={result.allowArbitraryQueues}
        />
      );
    }
    case "SCHEDULED": {
      return (
        <ScheduledTaskForm
          task={result.task}
          queues={queues}
          runs={result.runs}
          versions={result.latestVersions}
          possibleTimezones={result.possibleTimezones}
          disableVersionSelection={result.disableVersionSelection}
          allowArbitraryQueues={result.allowArbitraryQueues}
        />
      );
    }
    default: {
      return triggerSource satisfies never;
    }
  }
}

const startingJson = "{\n\n}";
const machinePresets = Object.values(MachinePresetName.enum);

function StandardTaskForm({
  task,
  queues,
  runs,
  versions,
  disableVersionSelection,
  allowArbitraryQueues,
}: {
  task: StandardTaskResult["task"];
  queues: Required<StandardTaskResult>["queue"][];
  runs: StandardRun[];
  versions: string[];
  disableVersionSelection: boolean;
  allowArbitraryQueues: boolean;
}) {
  const environment = useEnvironment();
  const { value, replace } = useSearchParams();
  const tab = value("tab");

  const lastSubmission = useActionData();
  const lastRun = runs[0];

  const [defaultPayloadJson, setDefaultPayloadJson] = useState<string>(
    lastRun?.payload ?? startingJson
  );
  const setPayload = useCallback((code: string) => {
    setDefaultPayloadJson(code);
  }, []);

  const currentPayloadJson = useRef<string>(defaultPayloadJson);

  const [defaultMetadataJson, setDefaultMetadataJson] = useState<string>(
    lastRun?.seedMetadata ?? "{}"
  );
  const setMetadata = useCallback((code: string) => {
    setDefaultMetadataJson(code);
  }, []);

  const currentMetadataJson = useRef<string>(defaultMetadataJson);

  const [ttlValue, setTtlValue] = useState<number | undefined>(lastRun?.ttlSeconds);
  const [concurrencyKeyValue, setConcurrencyKeyValue] = useState<string | undefined>(
    lastRun?.concurrencyKey
  );
  const [queueValue, setQueueValue] = useState<string | undefined>(lastRun?.queue);
  const [machineValue, setMachineValue] = useState<string | undefined>(lastRun?.machinePreset);
  const [maxAttemptsValue, setMaxAttemptsValue] = useState<number | undefined>(
    lastRun?.maxAttempts
  );
  const [maxDurationValue, setMaxDurationValue] = useState<number | undefined>(
    lastRun?.maxDurationInSeconds
  );
  const [tagsValue, setTagsValue] = useState<string[]>(lastRun?.runTags ?? []);

  const queueItems = queues.map((q) => ({
    value: q.type === "task" ? `task/${q.name}` : q.name,
    label: q.name,
    type: q.type,
    paused: q.paused,
  }));

  const fetcher = useFetcher();
  const [
    form,
    {
      environmentId,
      payload,
      metadata,
      taskIdentifier,
      delaySeconds,
      ttlSeconds,
      idempotencyKey,
      idempotencyKeyTTLSeconds,
      queue,
      concurrencyKey,
      maxAttempts,
      maxDurationSeconds,
      triggerSource,
      tags,
      version,
      machine,
    },
  ] = useForm({
    id: "test-task",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onSubmit(event, { formData }) {
      event.preventDefault();

      formData.set(payload.name, currentPayloadJson.current);
      formData.set(metadata.name, currentMetadataJson.current);

      fetcher.submit(formData, { method: "POST" });
    },
    onValidate({ formData }) {
      return parse(formData, { schema: TestTaskData });
    },
  });

  return (
    <Form className="flex h-full max-h-full flex-col" method="post" {...form.props}>
      <input {...conform.input(taskIdentifier, { type: "hidden" })} value={task.taskIdentifier} />
      <input {...conform.input(environmentId, { type: "hidden" })} value={environment.id} />
      <input {...conform.input(triggerSource, { type: "hidden" })} value={"STANDARD"} />
      <TabContainer className="flex items-baseline justify-between pl-3 pr-2 pt-1.5">
        <div className="flex gap-5">
          <TabButton
            isActive={!tab || tab === "payload"}
            layoutId="test-editor"
            onClick={() => {
              replace({ tab: "payload" });
            }}
          >
            Payload
          </TabButton>

          <TabButton
            isActive={tab === "metadata"}
            layoutId="test-editor"
            onClick={() => {
              replace({ tab: "metadata" });
            }}
          >
            Metadata
          </TabButton>
        </div>
        <div className="flex items-center gap-3">
          <RecentRunsPopover
            runs={runs}
            onRunSelected={(run) => {
              setPayload(run.payload);
              run.seedMetadata && setMetadata(run.seedMetadata);
              setTtlValue(run.ttlSeconds);
              setConcurrencyKeyValue(run.concurrencyKey);
              setMaxAttemptsValue(run.maxAttempts);
              setMaxDurationValue(run.maxDurationInSeconds);
              setTagsValue(run.runTags ?? []);
              setQueueValue(run.queue);
              setMachineValue(run.machinePreset);
            }}
          />
        </div>
      </TabContainer>
      <ResizablePanelGroup orientation="horizontal" className="grow">
        <ResizablePanel id="test-task-main" min="300px">
          <div className="flex h-full flex-col overflow-hidden bg-charcoal-900">
            <div className="flex-1 overflow-hidden">
              <JSONEditor
                defaultValue={defaultPayloadJson}
                readOnly={false}
                basicSetup
                onChange={(v) => {
                  currentPayloadJson.current = v;
                  setDefaultPayloadJson(v);
                }}
                height="100%"
                autoFocus={!tab || tab === "payload"}
                className={cn("h-full overflow-auto", tab === "metadata" && "hidden")}
              />
              <JSONEditor
                defaultValue={defaultMetadataJson}
                readOnly={false}
                basicSetup
                onChange={(v) => {
                  currentMetadataJson.current = v;
                  setDefaultMetadataJson(v);
                }}
                height="100%"
                autoFocus={tab === "metadata"}
                placeholder=""
                className={cn("h-full overflow-auto", tab !== "metadata" && "hidden")}
              />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle id="test-task-handle" />
        <ResizablePanel id="test-task-options" min="285px" default="285px" max="360px">
          <div className="h-full overflow-y-scroll">
            <Fieldset className="px-3 py-3">
              <InputGroup>
                <Label variant="small">Delay</Label>
                <DurationPicker name={delaySeconds.name} id={delaySeconds.id} />
                <FormError id={delaySeconds.errorId}>{delaySeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label variant="small">TTL</Label>
                <DurationPicker
                  name={ttlSeconds.name}
                  id={ttlSeconds.id}
                  value={ttlValue}
                  onChange={setTtlValue}
                />
                <Hint>The run will expire if it hasn't started within the TTL (time to live).</Hint>
                <FormError id={ttlSeconds.errorId}>{ttlSeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={queue.id} variant="small">
                  Queue
                </Label>
                {allowArbitraryQueues ? (
                  <Input
                    {...conform.input(queue, { type: "text" })}
                    variant="small"
                    value={queueValue ?? ""}
                    onChange={(e) => setQueueValue(e.target.value)}
                  />
                ) : (
                  <Select
                    name={queue.name}
                    id={queue.id}
                    placeholder="Select queue"
                    variant="tertiary/small"
                    dropdownIcon
                    items={queueItems}
                    filter={{ keys: ["label"] }}
                    value={queueValue}
                    setValue={setQueueValue}
                  >
                    {(matches) =>
                      matches.map((queueItem) => (
                        <SelectItem
                          key={queueItem.value}
                          value={queueItem.value}
                          className="max-w-[var(--popover-anchor-width)]"
                          icon={
                            queueItem.type === "task" ? (
                              <TaskIcon className="size-4 shrink-0 text-blue-500" />
                            ) : (
                              <RectangleStackIcon className="size-4 shrink-0 text-purple-500" />
                            )
                          }
                        >
                          <div className="flex w-full min-w-0 items-center justify-between">
                            <span className="truncate">{queueItem.label}</span>
                            {queueItem.paused && (
                              <Badge variant="extra-small" className="ml-1 text-warning">
                                Paused
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))
                    }
                  </Select>
                )}
                <FormError id={queue.errorId}>{queue.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={tags.id} variant="small">
                  Tags
                </Label>
                <RunTagInput
                  name={tags.name}
                  id={tags.id}
                  variant="small"
                  tags={tagsValue}
                  onTagsChange={setTagsValue}
                />
                <Hint>Tags enable you to easily filter runs.</Hint>
                <FormError id={tags.errorId}>{tags.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={maxAttempts.id} variant="small">
                  Max attempts
                </Label>
                <Input
                  {...conform.input(maxAttempts, { type: "number" })}
                  className="[&::-webkit-inner-spin-button]:appearance-none"
                  variant="small"
                  min={1}
                  value={maxAttemptsValue}
                  onChange={(e) =>
                    setMaxAttemptsValue(e.target.value ? parseInt(e.target.value) : undefined)
                  }
                  onKeyDown={(e) => {
                    // only allow entering integers > 1
                    if (["-", "+", ".", "e", "E"].includes(e.key)) {
                      e.preventDefault();
                    }
                  }}
                  onBlur={(e) => {
                    const value = parseInt(e.target.value);
                    if (value < 1 && e.target.value !== "") {
                      e.target.value = "1";
                    }
                  }}
                />
                <FormError id={maxAttempts.errorId}>{maxAttempts.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label variant="small">Max duration</Label>
                <DurationPicker
                  name={maxDurationSeconds.name}
                  id={maxDurationSeconds.id}
                  value={maxDurationValue}
                  onChange={setMaxDurationValue}
                />
                <FormError id={maxDurationSeconds.errorId}>{maxDurationSeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={idempotencyKey.id} variant="small">
                  Idempotency key
                </Label>
                <Input {...conform.input(idempotencyKey, { type: "text" })} variant="small" />
                <FormError id={idempotencyKey.errorId}>{idempotencyKey.error}</FormError>
                <Hint>
                  Specify an idempotency key to ensure that a task is only triggered once with the
                  same key.
                </Hint>
              </InputGroup>
              <InputGroup>
                <Label variant="small">Idempotency key TTL</Label>
                <DurationPicker
                  name={idempotencyKeyTTLSeconds.name}
                  id={idempotencyKeyTTLSeconds.id}
                />
                <Hint>By default, idempotency keys expire after 30 days.</Hint>
                <FormError id={idempotencyKeyTTLSeconds.errorId}>
                  {idempotencyKeyTTLSeconds.error}
                </FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={concurrencyKey.id} variant="small">
                  Concurrency key
                </Label>
                <Input
                  {...conform.input(concurrencyKey, { type: "text" })}
                  variant="small"
                  value={concurrencyKeyValue ?? ""}
                  onChange={(e) => setConcurrencyKeyValue(e.target.value)}
                />
                <Hint>
                  Concurrency keys enable you limit concurrency by creating a separate queue for
                  each value of the key.
                </Hint>
                <FormError id={concurrencyKey.errorId}>{concurrencyKey.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={machine.id} variant="small">
                  Machine
                </Label>
                <Select
                  {...conform.select(machine)}
                  variant="tertiary/small"
                  placeholder="Select machine type"
                  dropdownIcon
                  items={machinePresets}
                  defaultValue={undefined}
                  value={machineValue}
                  setValue={(e) => {
                    if (Array.isArray(e)) return;
                    setMachineValue(e);
                  }}
                >
                  {machinePresets.map((machine) => (
                    <SelectItem key={machine} value={machine}>
                      {machine}
                    </SelectItem>
                  ))}
                </Select>
                <Hint>This lets you override the machine preset specified in the task.</Hint>
                <FormError id={machine.errorId}>{machine.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={version.id} variant="small">
                  Version
                </Label>
                <Select
                  {...conform.select(version)}
                  defaultValue="latest"
                  variant="tertiary/small"
                  placeholder="Select version"
                  dropdownIcon
                  disabled={disableVersionSelection}
                >
                  {versions.map((version, i) => (
                    <SelectItem key={version} value={i === 0 ? "latest" : version}>
                      {version} {i === 0 && "(latest)"}
                    </SelectItem>
                  ))}
                </Select>
                {disableVersionSelection && (
                  <Hint>Only the latest version is available in the development environment.</Hint>
                )}
                <FormError id={version.errorId}>{version.error}</FormError>
              </InputGroup>
              <FormError>{form.error}</FormError>
            </Fieldset>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-end gap-3 border-t border-grid-bright bg-background-dimmed p-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Paragraph variant="small" className="whitespace-nowrap">
              This test will run in
            </Paragraph>
            <EnvironmentCombo environment={environment} className="gap-0.5" />
          </div>
          <Button
            type="submit"
            variant="primary/medium"
            LeadingIcon={BeakerIcon}
            shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
          >
            Run test
          </Button>
        </div>
      </div>
    </Form>
  );
}

function ScheduledTaskForm({
  task,
  runs,
  possibleTimezones,
  queues,
  versions,
  disableVersionSelection,
  allowArbitraryQueues,
}: {
  task: ScheduledTaskResult["task"];
  runs: ScheduledRun[];
  possibleTimezones: string[];
  queues: Required<ScheduledTaskResult>["queue"][];
  versions: string[];
  disableVersionSelection: boolean;
  allowArbitraryQueues: boolean;
}) {
  const environment = useEnvironment();
  const lastSubmission = useActionData();

  const lastRun = runs[0];

  const [timestampValue, setTimestampValue] = useState<Date | undefined>(
    lastRun.payload.timestamp ?? new Date()
  );
  const [lastTimestampValue, setLastTimestampValue] = useState<Date | undefined>(
    lastRun.payload.lastTimestamp
  );
  const [externalIdValue, setExternalIdValue] = useState<string | undefined>(
    lastRun.payload.externalId
  );
  const [timezoneValue, setTimezoneValue] = useState<string>(lastRun.payload.timezone ?? "UTC");
  const [ttlValue, setTtlValue] = useState<number | undefined>(lastRun?.ttlSeconds);
  const [concurrencyKeyValue, setConcurrencyKeyValue] = useState<string | undefined>(
    lastRun?.concurrencyKey
  );
  const [queueValue, setQueueValue] = useState<string | undefined>(lastRun?.queue);
  const [machineValue, setMachineValue] = useState<string | undefined>(lastRun?.machinePreset);
  const [maxAttemptsValue, setMaxAttemptsValue] = useState<number | undefined>(
    lastRun?.maxAttempts
  );
  const [maxDurationValue, setMaxDurationValue] = useState<number | undefined>(
    lastRun?.maxDurationInSeconds
  );
  const [tagsValue, setTagsValue] = useState<string[]>(lastRun?.runTags ?? []);

  const queueItems = queues.map((q) => ({
    value: q.type === "task" ? `task/${q.name}` : q.name,
    label: q.name,
    type: q.type,
    paused: q.paused,
  }));

  const [
    form,
    {
      timestamp,
      lastTimestamp,
      externalId,
      triggerSource,
      taskIdentifier,
      environmentId,
      timezone,
      ttlSeconds,
      idempotencyKey,
      idempotencyKeyTTLSeconds,
      queue,
      concurrencyKey,
      maxAttempts,
      maxDurationSeconds,
      tags,
      version,
      machine,
    },
  ] = useForm({
    id: "test-task-scheduled",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: TestTaskData });
    },
  });

  return (
    <Form className="flex h-full max-h-full flex-col" method="post" {...form.props}>
      <input
        type="hidden"
        {...conform.input(triggerSource, { type: "hidden" })}
        value={"SCHEDULED"}
      />
      <input
        type="hidden"
        {...conform.input(taskIdentifier, { type: "hidden" })}
        value={task.taskIdentifier}
      />
      <input
        type="hidden"
        {...conform.input(environmentId, { type: "hidden" })}
        value={environment.id}
      />
      <TabContainer className="flex items-baseline justify-between pl-3 pr-2 pt-1.5">
        <div className="flex gap-5">
          <TabButton isActive={true} layoutId="scheduled-task-options">
            Options
          </TabButton>
        </div>
        <div className="flex items-center gap-3">
          <RecentRunsPopover
            runs={runs}
            onRunSelected={(run) => {
              setTimestampValue(run.payload.timestamp);
              setLastTimestampValue(run.payload.lastTimestamp);
              setExternalIdValue(run.payload.externalId);
              setTimezoneValue(run.payload.timezone);
              setTtlValue(run.ttlSeconds);
              setConcurrencyKeyValue(run.concurrencyKey);
              setMaxAttemptsValue(run.maxAttempts);
              setMaxDurationValue(run.maxDurationInSeconds);
              setTagsValue(run.runTags ?? []);
              setQueueValue(run.queue);
              setMachineValue(run.machinePreset);
            }}
          />
        </div>
      </TabContainer>
      <div className="grow overflow-y-scroll p-3">
        <Fieldset>
          <InputGroup>
            <Label htmlFor={timestamp.id} variant="small">
              Timestamp UTC
            </Label>
            <input
              type="hidden"
              {...conform.input(timestamp, { type: "hidden" })}
              value={timestampValue?.toISOString() ?? ""}
            />
            <DateField
              label="Timestamp UTC"
              defaultValue={timestampValue}
              onValueChange={(val) => setTimestampValue(val)}
              granularity="second"
              showNowButton
              variant="small"
              utc
            />
            <Hint>
              This is the timestamp of the CRON, it will come through to your run in the payload.
            </Hint>
            <FormError id={timestamp.errorId}>{timestamp.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={lastTimestamp.id} variant="small">
              Last timestamp UTC
            </Label>
            <input
              type="hidden"
              {...conform.input(lastTimestamp, { type: "hidden" })}
              value={lastTimestampValue?.toISOString() ?? ""}
            />
            <DateField
              label="Last timestamp UTC"
              defaultValue={lastTimestampValue}
              onValueChange={(val) => setLastTimestampValue(val)}
              granularity="second"
              showNowButton
              showClearButton
              variant="small"
              utc
            />
            <Hint>
              This is the timestamp of the previous run. You can use this in your code to find new
              data since the previous run.
            </Hint>
            <FormError id={lastTimestamp.errorId}>{lastTimestamp.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={timezone.id} variant="small">
              Timezone
            </Label>
            <Select
              {...conform.select(timezone)}
              placeholder="Select a timezone"
              defaultValue={timezoneValue}
              value={timezoneValue}
              setValue={(e) => {
                if (Array.isArray(e)) return;
                setTimezoneValue(e);
              }}
              items={possibleTimezones}
              filter={{ keys: [(item) => item.replace(/\//g, " ").replace(/_/g, " ")] }}
              dropdownIcon
              variant="tertiary/small"
            >
              {(matches) => <TimezoneList timezones={matches} />}
            </Select>
            <Hint>
              The Timestamp and Last timestamp are in UTC so this just changes the timezone string
              that comes through in the payload.
            </Hint>
            <FormError id={timezone.errorId}>{timezone.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={externalId.id} variant="small">
              External ID
            </Label>
            <Input
              {...conform.input(externalId, { type: "text" })}
              placeholder="Optionally specify your own ID, e.g. user id"
              value={externalIdValue ?? ""}
              onChange={(e) => setExternalIdValue(e.target.value)}
              variant="small"
            />
            <Hint>
              Optionally, you can specify your own IDs (like a user ID) and then use it inside the
              run function of your task.{" "}
              <TextLink to={docsPath("v3/tasks-scheduled")}>Read the docs.</TextLink>
            </Hint>
            <FormError id={externalId.errorId}>{externalId.error}</FormError>
          </InputGroup>
          <div className="w-full border-b border-grid-bright"></div>
          <InputGroup>
            <Label htmlFor={ttlSeconds.id} variant="small">
              TTL
            </Label>
            <DurationPicker
              name={ttlSeconds.name}
              id={ttlSeconds.id}
              value={ttlValue}
              onChange={setTtlValue}
            />
            <Hint>The run will expire if it hasn't started within the TTL (time to live).</Hint>
            <FormError id={ttlSeconds.errorId}>{ttlSeconds.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={queue.id} variant="small">
              Queue
            </Label>
            {allowArbitraryQueues ? (
              <Input
                {...conform.input(queue, { type: "text" })}
                variant="small"
                value={queueValue ?? ""}
                onChange={(e) => setQueueValue(e.target.value)}
              />
            ) : (
              <Select
                name={queue.name}
                id={queue.id}
                placeholder="Select queue"
                variant="tertiary/small"
                dropdownIcon
                items={queueItems}
                filter={{ keys: ["label"] }}
                value={queueValue}
                setValue={setQueueValue}
              >
                {(matches) =>
                  matches.map((queueItem) => (
                    <SelectItem
                      key={queueItem.value}
                      value={queueItem.value}
                      className="max-w-[var(--popover-anchor-width)]"
                      icon={
                        queueItem.type === "task" ? (
                          <TaskIcon className="size-4 shrink-0 text-blue-500" />
                        ) : (
                          <RectangleStackIcon className="size-4 shrink-0 text-purple-500" />
                        )
                      }
                    >
                      <div className="flex w-full min-w-0 items-center justify-between">
                        <span className="truncate">{queueItem.label}</span>
                        {queueItem.paused && (
                          <Badge variant="extra-small" className="ml-1 text-warning">
                            Paused
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))
                }
              </Select>
            )}
            <FormError id={queue.errorId}>{queue.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={tags.id} variant="small">
              Tags
            </Label>
            <RunTagInput
              name={tags.name}
              id={tags.id}
              variant="small"
              tags={tagsValue}
              onTagsChange={setTagsValue}
            />
            <Hint>Tags enable you to easily filter runs.</Hint>
            <FormError id={tags.errorId}>{tags.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={maxAttempts.id} variant="small">
              Max attempts
            </Label>
            <Input
              {...conform.input(maxAttempts, { type: "number" })}
              className="[&::-webkit-inner-spin-button]:appearance-none"
              variant="small"
              min={1}
              value={maxAttemptsValue}
              onChange={(e) =>
                setMaxAttemptsValue(e.target.value ? parseInt(e.target.value) : undefined)
              }
              onKeyDown={(e) => {
                // only allow entering integers > 1
                if (["-", "+", ".", "e", "E"].includes(e.key)) {
                  e.preventDefault();
                }
              }}
              onBlur={(e) => {
                const value = parseInt(e.target.value);
                if (value < 1 && e.target.value !== "") {
                  e.target.value = "1";
                }
              }}
            />
            <FormError id={maxAttempts.errorId}>{maxAttempts.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={maxDurationSeconds.id} variant="small">
              Max duration
            </Label>
            <DurationPicker
              name={maxDurationSeconds.name}
              id={maxDurationSeconds.id}
              value={maxDurationValue}
              onChange={setMaxDurationValue}
            />
            <FormError id={maxDurationSeconds.errorId}>{maxDurationSeconds.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={idempotencyKey.id} variant="small">
              Idempotency key
            </Label>
            <Input {...conform.input(idempotencyKey, { type: "text" })} variant="small" />
            <FormError id={idempotencyKey.errorId}>{idempotencyKey.error}</FormError>
            <Hint>
              Specify an idempotency key to ensure that a task is only triggered once with the same
              key.
            </Hint>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={idempotencyKeyTTLSeconds.id} variant="small">
              Idempotency key TTL
            </Label>
            <DurationPicker name={idempotencyKeyTTLSeconds.name} id={idempotencyKeyTTLSeconds.id} />
            <Hint>By default, idempotency keys expire after 30 days.</Hint>
            <FormError id={idempotencyKeyTTLSeconds.errorId}>
              {idempotencyKeyTTLSeconds.error}
            </FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={concurrencyKey.id} variant="small">
              Concurrency key
            </Label>
            <Input
              {...conform.input(concurrencyKey, { type: "text" })}
              variant="small"
              value={concurrencyKeyValue ?? ""}
              onChange={(e) => setConcurrencyKeyValue(e.target.value)}
            />
            <Hint>
              Concurrency keys enable you limit concurrency by creating a separate queue for each
              value of the key.
            </Hint>
            <FormError id={concurrencyKey.errorId}>{concurrencyKey.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={machine.id} variant="small">
              Machine
            </Label>
            <Select
              {...conform.select(machine)}
              variant="tertiary/small"
              placeholder="Select machine type"
              dropdownIcon
              items={machinePresets}
              defaultValue={undefined}
              value={machineValue}
              setValue={(e) => {
                if (Array.isArray(e)) return;
                setMachineValue(e);
              }}
            >
              {machinePresets.map((machine) => (
                <SelectItem key={machine} value={machine}>
                  {machine}
                </SelectItem>
              ))}
            </Select>
            <Hint>This lets you override the machine preset specified in the task.</Hint>
            <FormError id={machine.errorId}>{machine.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={version.id} variant="small">
              Version
            </Label>
            <Select
              {...conform.select(version)}
              defaultValue="latest"
              variant="tertiary/small"
              placeholder="Select version"
              dropdownIcon
              disabled={disableVersionSelection}
            >
              {versions.map((version, i) => (
                <SelectItem key={version} value={i === 0 ? "latest" : version}>
                  {version} {i === 0 && "(latest)"}
                </SelectItem>
              ))}
            </Select>
            {disableVersionSelection && (
              <Hint>Only the latest version is available in the development environment.</Hint>
            )}
            <FormError id={version.errorId}>{version.error}</FormError>
          </InputGroup>
        </Fieldset>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-grid-bright bg-background-dimmed p-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Paragraph variant="small" className="whitespace-nowrap">
              This test will run in
            </Paragraph>
            <EnvironmentCombo environment={environment} className="gap-0.5" />
          </div>
          <Button
            type="submit"
            variant="primary/medium"
            LeadingIcon={BeakerIcon}
            shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
          >
            Run test
          </Button>
        </div>
      </div>
    </Form>
  );
}

function RecentRunsPopover<T extends StandardRun | ScheduledRun>({
  runs,
  onRunSelected,
}: {
  runs: T[];
  onRunSelected: (run: T) => void;
}) {
  const [isRecentRunsPopoverOpen, setIsRecentRunsPopoverOpen] = useState(false);

  return (
    <Popover open={isRecentRunsPopoverOpen} onOpenChange={setIsRecentRunsPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="tertiary/small"
          LeadingIcon={ClockRotateLeftIcon}
          disabled={runs.length === 0}
        >
          Recent runs
        </Button>
      </PopoverTrigger>
      <PopoverContent className="min-w-[279px] p-0" align="end" sideOffset={6}>
        <div className="max-h-80 overflow-y-auto">
          <div className="p-1">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => {
                  onRunSelected(run);
                  setIsRecentRunsPopoverOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 outline-none transition-colors focus-custom hover:bg-charcoal-900	"
              >
                <div className="flex flex-col items-start">
                  <Paragraph variant="small">
                    <DateTime date={run.createdAt} showTooltip={false} />
                  </Paragraph>
                  <div className="flex items-center gap-2 text-xs text-text-dimmed">
                    <div>
                      Run <span className="font-mono">{run.friendlyId.slice(-8)}</span>
                    </div>
                    <TaskRunStatusCombo status={run.status} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
