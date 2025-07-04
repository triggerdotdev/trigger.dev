import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BeakerIcon } from "@heroicons/react/20/solid";
import { RectangleStackIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useSubmit, useFetcher } from "@remix-run/react";
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
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { DurationPicker } from "~/components/primitives/DurationPicker";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { useParams } from "@remix-run/react";
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
  type TestTask,
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

  switch (result.task.triggerSource) {
    case "STANDARD": {
      return (
        <StandardTaskForm
          task={result.task.task}
          defaultQueue={result.task.queue}
          runs={result.task.runs}
        />
      );
    }
    case "SCHEDULED": {
      return (
        <ScheduledTaskForm
          task={result.task.task}
          runs={result.task.runs}
          possibleTimezones={result.task.possibleTimezones}
        />
      );
    }
  }
}

const startingJson = "{\n\n}";

function StandardTaskForm({
  task,
  defaultQueue,
  runs,
}: {
  task: TestTask["task"];
  defaultQueue: TestTask["queue"];
  runs: StandardRun[];
}) {
  const environment = useEnvironment();
  const { value, replace } = useSearchParams();
  const tab = value("tab");
  const params = useParams();

  //form submission
  const lastSubmission = useActionData();

  //recent runs
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(runs.at(0)?.id);
  const selectedCodeSample = runs.find((r) => r.id === selectedCodeSampleId);
  const selectedCodeSamplePayload = selectedCodeSample?.payload;
  const selectedCodeSampleMetadata = selectedCodeSample?.seedMetadata;

  const [defaultPayloadJson, setDefaultPayloadJson] = useState<string>(
    selectedCodeSamplePayload ?? startingJson
  );
  const setPayload = useCallback((code: string) => {
    setDefaultPayloadJson(code);
  }, []);

  const currentPayloadJson = useRef<string>(defaultPayloadJson);

  const [defaultMetadataJson, setDefaultMetadataJson] = useState<string>(
    selectedCodeSampleMetadata ?? "{}"
  );
  const setMetadata = useCallback((code: string) => {
    setDefaultMetadataJson(code);
  }, []);

  const currentMetadataJson = useRef<string>(defaultMetadataJson);

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

  const queues = useMemo(() => {
    const defaultQueueItem = defaultQueue
      ? {
          value: defaultQueue.type === "task" ? `task/${defaultQueue.name}` : defaultQueue.name,
          label: defaultQueue.name,
          type: defaultQueue.type,
          paused: defaultQueue.paused,
        }
      : undefined;

    if (!queueFetcher.data?.queues) {
      return defaultQueueItem ? [defaultQueueItem] : [];
    }

    const customQueues = queueFetcher.data?.queues.map((queue) => ({
      value: queue.name,
      label: queue.name,
      type: queue.type,
      paused: queue.paused,
    }));

    return defaultQueueItem ? [defaultQueueItem, ...customQueues] : customQueues;
  }, [queueFetcher.data?.queues, defaultQueue]);

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
    <Form className="grid h-full max-h-full grid-rows-[1fr_auto]" method="post" {...form.props}>
      <input {...conform.input(taskIdentifier, { type: "hidden" })} value={task.taskIdentifier} />
      <input {...conform.input(environmentId, { type: "hidden" })} value={environment.id} />
      <input {...conform.input(triggerSource, { type: "hidden" })} value={"STANDARD"} />
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="test-task-main" min="100px" default="60%">
          <div className="flex h-full flex-col overflow-hidden bg-charcoal-900">
            <TabContainer className="px-3 pt-2">
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
            </TabContainer>
            <div className="flex-1 overflow-hidden">
              <JSONEditor
                defaultValue={defaultPayloadJson}
                readOnly={false}
                basicSetup
                onChange={(v) => {
                  currentPayloadJson.current = v;

                  //deselect the example if it's been edited
                  if (selectedCodeSampleId) {
                    if (v !== selectedCodeSamplePayload) {
                      setDefaultPayloadJson(v);
                      setSelectedCodeSampleId(undefined);
                    }
                  }
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

                  //deselect the example if it's been edited
                  if (selectedCodeSampleId) {
                    if (v !== selectedCodeSampleMetadata) {
                      setDefaultMetadataJson(v);
                      setSelectedCodeSampleId(undefined);
                    }
                  }
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
        <ResizablePanel id="test-task-options" min="200px">
          <div className="flex h-full flex-col gap-2">
            <div className="flex min-h-[39px] items-center border-b border-grid-dimmed px-3">
              <Header2>Options</Header2>
            </div>
            <Fieldset className="grow overflow-y-scroll px-3 pb-4 pt-1">
              <InputGroup>
                <Label>Delay</Label>
                <DurationPicker name={delaySeconds.name} id={delaySeconds.id} />
                <FormError id={delaySeconds.errorId}>{delaySeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label>TTL</Label>
                <DurationPicker name={ttlSeconds.name} id={ttlSeconds.id} />
                <FormError id={ttlSeconds.errorId}>{ttlSeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={idempotencyKey.id}>Idempotency key</Label>
                <Input {...conform.input(idempotencyKey, { type: "text" })} variant="small" />
                <FormError id={idempotencyKey.errorId}>{idempotencyKey.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label>Idempotency key TTL</Label>
                <DurationPicker
                  name={idempotencyKeyTTLSeconds.name}
                  id={idempotencyKeyTTLSeconds.id}
                />
                <FormError id={idempotencyKeyTTLSeconds.errorId}>
                  {idempotencyKeyTTLSeconds.error}
                </FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={queue.id}>Queue</Label>
                <Select
                  name={queue.name}
                  id={queue.id}
                  placeholder="Select queue"
                  variant="tertiary/small"
                  dropdownIcon
                  items={queues}
                  filter={{ keys: ["label"] }}
                  defaultValue={undefined}
                >
                  {(matches) =>
                    matches.map((queueItem) => (
                      <SelectItem
                        key={queueItem.value}
                        value={queueItem.value}
                        icon={
                          queueItem.type === "task" ? (
                            <TaskIcon className="size-4 text-blue-500" />
                          ) : (
                            <RectangleStackIcon className="size-4 text-purple-500" />
                          )
                        }
                      >
                        <div className="flex w-full min-w-0 items-center justify-between">
                          {queueItem.label}
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
                <FormError id={queue.errorId}>{queue.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={concurrencyKey.id}>Concurrency key</Label>
                <Input {...conform.input(concurrencyKey, { type: "text" })} variant="small" />
                <FormError id={concurrencyKey.errorId}>{concurrencyKey.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={maxAttempts.id}>Max attempts</Label>
                <Input
                  {...conform.input(maxAttempts, { type: "number" })}
                  className="[&::-webkit-inner-spin-button]:appearance-none"
                  variant="small"
                  min={0}
                />
              </InputGroup>
              <InputGroup>
                <Label>Max duration</Label>
                <DurationPicker name={maxDurationSeconds.name} id={maxDurationSeconds.id} />
                <FormError id={maxDurationSeconds.errorId}>{maxDurationSeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={tags.id}>Tags</Label>
                <RunTagInput name={tags.name} id={tags.id} variant="small" />
                <FormError id={tags.errorId}>{tags.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={version.id}>Version</Label>
                <Select
                  {...conform.select(version)}
                  defaultValue="latest"
                  variant="tertiary/small"
                  placeholder="Select version"
                  dropdownIcon
                >
                  <SelectItem key="latest" value="latest">
                    latest
                  </SelectItem>
                </Select>
                <FormError id={version.errorId}>{version.error}</FormError>
              </InputGroup>
              <FormError>{form.error}</FormError>
            </Fieldset>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-end gap-3 border-t border-grid-bright bg-background-dimmed p-2">
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
    </Form>
  );
}

function ScheduledTaskForm({
  task,
  runs,
  possibleTimezones,
}: {
  task: TestTask["task"];
  runs: ScheduledRun[];
  possibleTimezones: string[];
}) {
  const environment = useEnvironment();
  const lastSubmission = useActionData();
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(runs.at(0)?.id);
  const [timestampValue, setTimestampValue] = useState<Date | undefined>();
  const [lastTimestampValue, setLastTimestampValue] = useState<Date | undefined>();
  const [externalIdValue, setExternalIdValue] = useState<string | undefined>();
  const [timezoneValue, setTimezoneValue] = useState<string>("UTC");

  //set initial values
  useEffect(() => {
    const initialRun = runs.find((r) => r.id === selectedCodeSampleId);
    if (!initialRun) {
      setTimestampValue(new Date());
      return;
    }

    setTimestampValue(initialRun.payload.timestamp);
    setLastTimestampValue(initialRun.payload.lastTimestamp);
    setExternalIdValue(initialRun.payload.externalId);
    setTimezoneValue(initialRun.payload.timezone);
  }, [selectedCodeSampleId]);

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
    <Form className="grid h-full max-h-full grid-rows-[1fr_auto]" method="post" {...form.props}>
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
      <div className="p-3">
        <Fieldset>
          <InputGroup>
            <Label htmlFor={timestamp.id}>Timestamp UTC</Label>
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
              variant="medium"
              utc
            />
            <Hint>
              This is the timestamp of the CRON, it will come through to your run in the payload.
            </Hint>
            <FormError id={timestamp.errorId}>{timestamp.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={lastTimestamp.id} required={false}>
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
              variant="medium"
              utc
            />
            <Hint>
              This is the timestamp of the previous run. You can use this in your code to find new
              data since the previous run. This can be undefined if there hasn't been a previous
              run.
            </Hint>
            <FormError id={lastTimestamp.errorId}>{lastTimestamp.error}</FormError>
          </InputGroup>
          <InputGroup>
            <Label htmlFor={timezone.id}>Timezone</Label>
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
              variant="tertiary/medium"
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
            <Label required={false} htmlFor={externalId.id}>
              External ID
            </Label>
            <Input
              {...conform.input(externalId, { type: "text" })}
              placeholder="Optionally specify your own ID, e.g. user id"
              value={externalIdValue ?? ""}
              onChange={(e) => setExternalIdValue(e.target.value)}
            />
            <Hint>
              Optionally, you can specify your own IDs (like a user ID) and then use it inside the
              run function of your task. This allows you to have per-user CRON tasks.{" "}
              <TextLink to={docsPath("v3/tasks-scheduled")}>Read the docs.</TextLink>
            </Hint>
            <FormError id={externalId.errorId}>{externalId.error}</FormError>
          </InputGroup>
        </Fieldset>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-grid-bright bg-background-dimmed p-2">
        <div className="flex items-center gap-1">
          <Paragraph variant="small" className="whitespace-nowrap">
            This test will run in
          </Paragraph>
          <EnvironmentCombo environment={environment} className="gap-0.5" />
        </div>
        <Button
          type="submit"
          variant="primary/small"
          LeadingIcon={BeakerIcon}
          shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
        >
          Run test
        </Button>
      </div>
    </Form>
  );
}
