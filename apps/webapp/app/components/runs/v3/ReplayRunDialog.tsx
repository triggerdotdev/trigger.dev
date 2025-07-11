import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useNavigation, useParams, useSubmit } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type UseDataFunctionReturn, useTypedFetcher } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { DurationPicker } from "~/components/primitives/DurationPicker";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { type loader as queuesLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { type loader } from "~/routes/resources.taskruns.$runParam.replay";
import { docsPath } from "~/utils/pathBuilder";
import { ReplayRunData } from "~/v3/replayTask";
import { RectangleStackIcon } from "@heroicons/react/20/solid";
import { Badge } from "~/components/primitives/Badge";
import { RunTagInput } from "./RunTagInput";
import { MachinePresetName } from "@trigger.dev/core/v3";

type ReplayRunDialogProps = {
  runFriendlyId: string;
  failedRedirect: string;
};

export function ReplayRunDialog({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  return (
    <DialogContent
      key={`replay`}
      className="flex h-[85vh] max-h-[85vh] flex-col overflow-hidden px-0 md:max-w-3xl lg:max-w-5xl"
    >
      <ReplayContent runFriendlyId={runFriendlyId} failedRedirect={failedRedirect} />
    </DialogContent>
  );
}

function ReplayContent({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  const replayDataFetcher = useTypedFetcher<typeof loader>();
  const isLoading = replayDataFetcher.state === "loading";
  const queueFetcher = useTypedFetcher<typeof queuesLoader>();

  const [environmentIdOverride, setEnvironmentIdOverride] = useState<string | undefined>(undefined);

  useEffect(() => {
    const searchParams = new URLSearchParams();
    if (environmentIdOverride) {
      searchParams.set("environmentIdOverride", environmentIdOverride);
    }

    replayDataFetcher.load(
      `/resources/taskruns/${runFriendlyId}/replay?${searchParams.toString()}`
    );
  }, [runFriendlyId, environmentIdOverride]);

  const params = useParams();
  useEffect(() => {
    if (params.organizationSlug && params.projectParam && params.envParam) {
      const searchParams = new URLSearchParams();
      searchParams.set("type", "custom");
      searchParams.set("per_page", "100");

      let envSlug = params.envParam;

      if (environmentIdOverride) {
        const environmentOverride = replayDataFetcher.data?.environments.find(
          (env) => env.id === environmentIdOverride
        );
        envSlug = environmentOverride?.slug ?? envSlug;
      }

      queueFetcher.load(
        `/resources/orgs/${params.organizationSlug}/projects/${
          params.projectParam
        }/env/${envSlug}/queues?${searchParams.toString()}`
      );
    }
  }, [params.organizationSlug, params.projectParam, params.envParam, environmentIdOverride]);

  const customQueues = useMemo(() => {
    return queueFetcher.data?.queues ?? [];
  }, [queueFetcher.data?.queues]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <DialogHeader className="px-3">Replay this run</DialogHeader>
      {isLoading && !replayDataFetcher.data ? (
        <div className="flex h-full items-center justify-center p-6">
          <Spinner />
        </div>
      ) : replayDataFetcher.data ? (
        <ReplayForm
          replayData={replayDataFetcher.data}
          failedRedirect={failedRedirect}
          runFriendlyId={runFriendlyId}
          customQueues={customQueues}
          environmentIdOverride={environmentIdOverride}
          setEnvironmentIdOverride={setEnvironmentIdOverride}
        />
      ) : (
        <>Failed to get run data</>
      )}
    </div>
  );
}

const startingJson = "{\n\n}";
const machinePresets = Object.values(MachinePresetName.enum);

function ReplayForm({
  failedRedirect,
  runFriendlyId,
  replayData,
  customQueues,
  environmentIdOverride,
  setEnvironmentIdOverride,
}: {
  failedRedirect: string;
  runFriendlyId: string;
  replayData: UseDataFunctionReturn<typeof loader>;
  customQueues: UseDataFunctionReturn<typeof queuesLoader>["queues"];
  environmentIdOverride: string | undefined;
  setEnvironmentIdOverride: (environment: string) => void;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();

  const [defaultPayloadJson, setDefaultPayloadJson] = useState<string>(
    replayData.payload ?? startingJson
  );
  const setPayload = useCallback((code: string) => {
    setDefaultPayloadJson(code);
  }, []);
  const currentPayloadJson = useRef<string>(replayData.payload ?? startingJson);

  const [defaultMetadataJson, setDefaultMetadataJson] = useState<string>(
    replayData.metadata ?? startingJson
  );
  const setMetadata = useCallback((code: string) => {
    setDefaultMetadataJson(code);
  }, []);
  const currentMetadataJson = useRef<string>(replayData.metadata ?? startingJson);

  const formAction = `/resources/taskruns/${runFriendlyId}/replay`;

  const isSubmitting = navigation.formAction === formAction;

  const editablePayload =
    replayData.payloadType === "application/json" ||
    replayData.payloadType === "application/super+json";

  const [tab, setTab] = useState<"payload" | "metadata">("payload");

  const { defaultTaskQueue } = replayData;

  const queues =
    defaultTaskQueue && !customQueues.some((q) => q.id === defaultTaskQueue.id)
      ? [defaultTaskQueue, ...customQueues]
      : customQueues;

  const queueItems = queues.map((q) => ({
    value: q.type === "task" ? `task/${q.name}` : q.name,
    label: q.name,
    type: q.type,
    paused: q.paused,
  }));

  const lastSubmission = useActionData();
  const [
    form,
    {
      environment,
      payload,
      metadata,
      delaySeconds,
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
    id: "replay-task",
    lastSubmission: lastSubmission as any,
    onSubmit(event, { formData }) {
      event.preventDefault();
      if (editablePayload) {
        formData.set(payload.name, currentPayloadJson.current);
      }
      formData.set(metadata.name, currentMetadataJson.current);

      submit(formData, { method: "POST", action: formAction });
    },
    onValidate({ formData }) {
      return parse(formData, { schema: ReplayRunData });
    },
  });

  return (
    <Form
      action={formAction}
      method="post"
      className="flex flex-1 flex-col overflow-hidden px-3"
      {...form.props}
    >
      <input type="hidden" name="failedRedirect" value={failedRedirect} />

      <Paragraph className="pt-6">
        Replaying will create a new run in the selected environment. You can modify the payload,
        metadata and run options.
      </Paragraph>
      <ResizablePanelGroup
        orientation="horizontal"
        className="-mx-3 mt-3 w-auto flex-1 border-b border-t border-grid-dimmed"
      >
        <ResizablePanel id="payload" min="300px">
          <div className="rounded-smbg-charcoal-900 mb-3 h-full min-h-40 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <JSONEditor
              autoFocus
              defaultValue={tab === "payload" ? defaultPayloadJson : defaultMetadataJson}
              readOnly={false}
              basicSetup
              onChange={(v) => {
                if (tab === "payload") {
                  currentPayloadJson.current = v;
                  setPayload(v);
                } else {
                  currentMetadataJson.current = v;
                  setMetadata(v);
                }
              }}
              height="100%"
              min-height="100%"
              max-height="100%"
              additionalActions={
                <TabContainer className="flex grow items-baseline justify-between self-end border-none">
                  <div className="flex gap-5">
                    <TabButton
                      isActive={tab === "payload"}
                      layoutId="replay-editor"
                      onClick={() => {
                        setTab("payload");
                      }}
                    >
                      Payload
                    </TabButton>
                    <TabButton
                      isActive={tab === "metadata"}
                      layoutId="replay-editor"
                      onClick={() => {
                        setTab("metadata");
                      }}
                    >
                      Metadata
                    </TabButton>
                  </div>
                </TabContainer>
              }
            />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="test-task-options" min="300px" default="300px" max="360px">
          <div className="h-full overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <Fieldset className="px-3 py-3">
              <Hint>
                Options enable you to control the execution behavior of your task.{" "}
                <TextLink to={docsPath("triggering#options")}>Read the docs.</TextLink>
              </Hint>
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
                  defaultValue={replayData.machinePreset ?? undefined}
                >
                  {machinePresets.map((machine) => (
                    <SelectItem key={machine} value={machine}>
                      {machine}
                    </SelectItem>
                  ))}
                </Select>
                <Hint>Overrides the machine preset.</Hint>
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
                  disabled={replayData.disableVersionSelection}
                >
                  {replayData.latestVersions.length === 0 ? (
                    <SelectItem disabled>No versions available</SelectItem>
                  ) : (
                    replayData.latestVersions.map((version, i) => (
                      <SelectItem key={version} value={i === 0 ? "latest" : version}>
                        {version} {i === 0 && "(latest)"}
                      </SelectItem>
                    ))
                  )}
                </Select>
                {replayData.disableVersionSelection ? (
                  <Hint>Only the latest version is available in the development environment.</Hint>
                ) : (
                  <Hint>Runs task on a specific version.</Hint>
                )}
                <FormError id={version.errorId}>{version.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={queue.id} variant="small">
                  Queue
                </Label>
                {replayData.allowArbitraryQueues ? (
                  <Input
                    {...conform.input(queue, { type: "text" })}
                    variant="small"
                    defaultValue={replayData.queue}
                  />
                ) : (
                  <Select
                    name={queue.name}
                    id={queue.id}
                    placeholder="Select queue"
                    heading="Filter queues"
                    variant="tertiary/small"
                    dropdownIcon
                    items={queueItems}
                    filter={{ keys: ["label"] }}
                    defaultValue={replayData.queue}
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
                <Hint>Assign run to a specific queue.</Hint>
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
                  defaultTags={replayData.runTags}
                />
                <Hint>Add tags to easily filter runs.</Hint>
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
                  defaultValue={replayData.maxAttempts ?? undefined}
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
                <Hint>Retries failed runs up to the specified number of attempts.</Hint>
                <FormError id={maxAttempts.errorId}>{maxAttempts.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label variant="small">Max duration</Label>
                <DurationPicker
                  name={maxDurationSeconds.name}
                  id={maxDurationSeconds.id}
                  defaultValueSeconds={replayData.maxDurationSeconds ?? undefined}
                />
                <Hint>Overrides the maximum compute time limit for the run.</Hint>
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
                <Hint>Keys expire after 30 days by default.</Hint>
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
                  defaultValue={replayData.concurrencyKey ?? undefined}
                />
                <Hint>
                  Limits concurrency by creating a separate queue for each value of the key.
                </Hint>
                <FormError id={concurrencyKey.errorId}>{concurrencyKey.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label variant="small">Delay</Label>
                <DurationPicker name={delaySeconds.name} id={delaySeconds.id} />
                <Hint>Delays run by a specific duration.</Hint>
                <FormError id={delaySeconds.errorId}>{delaySeconds.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label variant="small">TTL</Label>
                <DurationPicker
                  name={ttlSeconds.name}
                  id={ttlSeconds.id}
                  defaultValueSeconds={replayData.ttlSeconds}
                />
                <Hint>Expires the run if it hasn't started within the TTL.</Hint>
                <FormError id={ttlSeconds.errorId}>{ttlSeconds.error}</FormError>
              </InputGroup>
              <FormError>{form.error}</FormError>
            </Fieldset>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed pt-3.5">
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <div className="flex items-center gap-3">
          <InputGroup className="flex flex-row items-center">
            <Label>Replay this run in</Label>
            <Select
              {...conform.select(environment)}
              placeholder="Select an environment"
              defaultValue={replayData.environment.id}
              items={replayData.environments}
              dropdownIcon
              value={environmentIdOverride}
              setValue={setEnvironmentIdOverride}
              variant="tertiary/medium"
              className="w-fit pl-1"
              filter={{
                keys: [
                  (item) => item.type.replace(/\//g, " ").replace(/_/g, " "),
                  (item) => item.branchName?.replace(/\//g, " ").replace(/_/g, " ") ?? "",
                ],
              }}
              text={(value) => {
                const env = replayData.environments.find((env) => env.id === value)!;
                return (
                  <div className="flex items-center pl-1 pr-2">
                    <EnvironmentCombo environment={env} />
                  </div>
                );
              }}
            >
              {(matches) =>
                matches.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    <EnvironmentCombo environment={env} />
                  </SelectItem>
                ))
              }
            </Select>
          </InputGroup>
          <Button
            type="submit"
            variant="primary/medium"
            LeadingIcon={isSubmitting ? SpinnerWhite : undefined}
            disabled={isSubmitting}
            shortcut={{ modifiers: ["mod"], key: "enter", enabledOnInputElements: true }}
          >
            {isSubmitting ? "Replaying..." : "Replay run"}
          </Button>
        </div>
      </div>
    </Form>
  );
}
