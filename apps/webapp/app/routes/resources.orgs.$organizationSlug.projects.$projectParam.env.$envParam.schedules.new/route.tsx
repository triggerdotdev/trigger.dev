import { getFormProps, getInputProps, getSelectProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { ScheduleWindow } from "@trigger.dev/core/v3";
import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import {
  type FetcherWithComponents,
  Form,
  useActionData,
  useLocation,
  useNavigation,
} from "@remix-run/react";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { parseExpression } from "cron-parser";
import cronstrue from "cronstrue";
import { useState } from "react";
import {
  EnvironmentCombo,
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { DateTime } from "~/components/primitives/DateTime";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { TimezoneList } from "~/components/scheduled/timezones";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import type { EditableScheduleElements } from "~/presenters/v3/EditSchedulePresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema, docsPath, v3EnvironmentPath } from "~/utils/pathBuilder";
import { CronPattern, UpsertSchedule } from "~/v3/schedules";
import { validateMinimumCronInterval } from "~/v3/validateMinimumCronInterval";
import { explicitWindowBelowMinimum } from "~/v3/explicitWindowBelowMinimum";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";
import { AIGeneratedCronField } from "../resources.orgs.$organizationSlug.projects.$projectParam.schedules.new.natural-language";

const cronFormat = `*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    |
│    │    │    │    └ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)
│    │    │    └───── month (1 - 12)
│    │    └────────── day of month (1 - 31, L)
│    └─────────────── hour (0 - 23)
└──────────────────── minute (0 - 59)`;

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: UpsertSchedule });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  // `_format=json` → return JSON instead of redirecting; caller toasts.
  const wantsJson = formData.get("_format") === "json";

  try {
    //first check that the user has access to the project
    const project = await prisma.project.findUnique({
      where: {
        slug: projectParam,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      select: { id: true },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const createSchedule = new UpsertTaskScheduleService();
    const result = await createSchedule.call(project.id, submission.value);

    const message =
      submission.value?.friendlyId === result.id ? "Schedule updated" : "Schedule created";

    if (wantsJson) {
      return json({ ok: true as const, message });
    }

    return redirectWithSuccessMessage(
      v3EnvironmentPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
      request,
      message
    );
  } catch (error: any) {
    if (!(error instanceof ServiceValidationError)) {
      logger.error("Failed to create schedule", { error, organizationSlug });
    }

    const errorMessage =
      error instanceof ServiceValidationError
        ? error.message
        : `Something went wrong. Please try again.`;
    if (wantsJson) {
      if (error instanceof ServiceValidationError) {
        return json(submission.reply({ formErrors: [error.message] }), {
          status: error.status ?? 422,
        });
      }

      return json({ ok: false as const, message: errorMessage }, { status: 500 });
    }
    return redirectWithErrorMessage(
      v3EnvironmentPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
      request,
      errorMessage
    );
  }
};

type CronPatternResult =
  | {
      isValid: true;
      description: string;
    }
  | {
      isValid: false;
      error: string;
      isPlanLimit?: boolean;
    };

type ScheduleWindowResult =
  | {
      isValid: true;
    }
  | {
      isValid: false;
      error: string;
    };

export function UpsertScheduleForm({
  schedule,
  possibleTasks,
  possibleEnvironments,
  possibleTimezones,
  newSchedulePolicy,
  showGenerateField,
  defaultTaskIdentifier,
  onCancel,
  submitFetcher,
}: Omit<EditableScheduleElements, "newSchedulePolicy"> & {
  newSchedulePolicy?: EditableScheduleElements["newSchedulePolicy"];
  showGenerateField: boolean;
  /** Pre-fills the Task field on new schedules. Ignored when editing. */
  defaultTaskIdentifier?: string;
  /** When set, Cancel calls back instead of navigating. */
  onCancel?: () => void;
  /** Submits via this fetcher with `_format=json` so the host can toast/close itself. */
  submitFetcher?: FetcherWithComponents<unknown>;
}) {
  const actionData = useActionData();
  // Only feed conform-shaped data (`status`) to `useForm` — `{ ok, message }`
  // envelopes lack it and crash conform.
  const fetcherSubmission =
    submitFetcher?.data && typeof submitFetcher.data === "object" && "status" in submitFetcher.data
      ? submitFetcher.data
      : undefined;
  const lastSubmission = submitFetcher ? fetcherSubmission : actionData;
  const [selectedTimezone, setSelectedTimezone] = useState<string>(schedule?.timezone ?? "UTC");
  const isUtc = selectedTimezone === "UTC";
  const [cronPattern, setCronPattern] = useState<string>(schedule?.cron ?? "");
  const [scheduleWindowValue, setScheduleWindowValue] = useState<string>(schedule?.window ?? "");
  const navigation = useNavigation();
  const isLoading = submitFetcher ? submitFetcher.state !== "idle" : navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();

  const [
    form,
    {
      taskIdentifier,
      cron,
      timezone,
      window: scheduleWindow,
      externalId,
      environments,
      deduplicationKey,
    },
  ] = useForm({
    // Disambiguate per-schedule so both sheets (create + edit) can
    // coexist without duplicate DOM ids breaking `htmlFor` / conform.
    id: schedule?.friendlyId ? `edit-schedule-${schedule.friendlyId}` : "create-schedule",
    // TODO: type this
    lastResult: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: UpsertSchedule });
    },
  });

  const defaultWindowDurationSeconds = schedule
    ? schedule.defaultWindowDurationSeconds
    : newSchedulePolicy?.defaultWindowDurationSeconds;
  const minimumWindowDurationSeconds = schedule
    ? schedule.minimumWindowDurationSeconds
    : newSchedulePolicy?.minimumWindowDurationSeconds;

  let cronPatternResult: CronPatternResult | undefined = undefined;
  let scheduleWindowResult: ScheduleWindowResult | undefined = undefined;
  let nextRuns: Date[] | undefined = undefined;
  let minimumWindowApplied = false;

  if (scheduleWindowValue !== "") {
    const result = ScheduleWindow.safeParse(scheduleWindowValue);
    scheduleWindowResult = result.success
      ? { isValid: true }
      : { isValid: false, error: result.error.issues[0].message };
  }

  if (cronPattern !== "") {
    const result = CronPattern.safeParse(cronPattern);

    if (!result.success) {
      cronPatternResult = {
        isValid: false,
        error: result.error.issues[0].message,
      };
    } else {
      try {
        const expression = parseExpression(
          cronPattern,
          isUtc ? { utc: true } : { tz: selectedTimezone }
        );
        const minimumIntervalResult = minimumWindowDurationSeconds
          ? validateMinimumCronInterval({
              cron: cronPattern,
              timezone: selectedTimezone,
              minimumMs: minimumWindowDurationSeconds * 1_000,
            })
          : undefined;
        cronPatternResult =
          minimumIntervalResult?.valid === false
            ? {
                isValid: false,
                error: `Schedules must have at least ${Math.round(
                  minimumWindowDurationSeconds! / 60
                )} minutes between runs.`,
                isPlanLimit: true,
              }
            : {
                isValid: true,
                description: cronstrue.toString(cronPattern),
              };
        nextRuns = Array.from({ length: 5 }, (_, i) => {
          const utc = expression.next().toDate();
          return utc;
        });
      } catch (e) {
        cronPatternResult = {
          isValid: false,
          error: e instanceof Error ? e.message : JSON.stringify(e),
        };
      }
    }
  }

  if (scheduleWindowResult?.isValid && minimumWindowDurationSeconds && nextRuns) {
    minimumWindowApplied = explicitWindowBelowMinimum({
      explicitWindow: scheduleWindowValue,
      cron: cronPattern,
      timezone: isUtc ? null : selectedTimezone,
      minimumWindowDurationSeconds,
    });
  }

  const mode = schedule ? "edit" : "new";
  const FormComponent = submitFetcher?.Form ?? Form;

  return (
    <FormComponent
      method="post"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/schedules/new`}
      {...getFormProps(form)}
      className="grid h-full max-h-full grid-rows-[2.5rem_1fr_auto] overflow-hidden bg-background-bright"
    >
      <div className="mx-3 flex min-w-0 items-center justify-between gap-2 overflow-hidden border-b border-grid-dimmed">
        <Header2 className="truncate">
          {schedule?.friendlyId
            ? "Edit schedule"
            : defaultTaskIdentifier
              ? `New schedule for ${defaultTaskIdentifier}`
              : "New schedule"}
        </Header2>
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <div className="p-3">
          {submitFetcher ? <input type="hidden" name="_format" value="json" /> : null}
          {schedule && <input type="hidden" name="friendlyId" value={schedule.friendlyId} />}
          <Fieldset>
            {(() => {
              // Lock the task via hidden input when it's implied (sheet on a task page, or editing).
              const lockedTaskIdentifier = schedule?.taskIdentifier ?? defaultTaskIdentifier;
              return lockedTaskIdentifier ? (
                <input type="hidden" name={taskIdentifier.name} value={lockedTaskIdentifier} />
              ) : (
                <InputGroup>
                  <Label htmlFor={taskIdentifier.id}>Task</Label>
                  <Select
                    {...getSelectProps(taskIdentifier)}
                    placeholder="Select a task"
                    defaultValue={schedule?.taskIdentifier}
                    heading={"Filter..."}
                    items={possibleTasks}
                    filter={(task, search) => task.toLowerCase().includes(search.toLowerCase())}
                    dropdownIcon
                    variant="tertiary/medium"
                  >
                    {(matches) =>
                      matches?.map((task) => (
                        <SelectItem key={task} value={task}>
                          {task}
                        </SelectItem>
                      ))
                    }
                  </Select>
                  <FormError id={taskIdentifier.errorId}>{taskIdentifier.errors}</FormError>
                </InputGroup>
              );
            })()}
            {showGenerateField && <AIGeneratedCronField onSuccess={setCronPattern} />}
            <InputGroup>
              <Label
                htmlFor={cron.id}
                tooltip={
                  <div className="spacy-y-3">
                    <Paragraph variant="extra-small">We support this CRON format:</Paragraph>
                    <code>
                      <pre>{cronFormat}</pre>
                    </code>
                    <Paragraph variant="extra-small">"L" means the last.</Paragraph>
                  </div>
                }
              >
                CRON pattern (UTC)
              </Label>
              <Input
                {...getInputProps(cron, { type: "text" })}
                placeholder="? ? ? ? ?"
                required={true}
                value={cronPattern}
                onChange={(e) => {
                  setCronPattern(e.target.value);
                }}
              />
              {cronPatternResult === undefined ? (
                <Hint>Enter a CRON pattern or use natural language above.</Hint>
              ) : cronPatternResult.isValid ? (
                <ValidationMessage
                  isValid={true}
                  validLabel="Valid pattern:"
                  invalidLabel="Invalid pattern:"
                  message={`${cronPatternResult.description}.`}
                />
              ) : (
                <ValidationMessage
                  isValid={false}
                  validLabel="Valid pattern:"
                  invalidLabel={
                    cronPatternResult.isPlanLimit ? "Unavailable on Free plan:" : "Invalid pattern:"
                  }
                  message={cronPatternResult.error}
                />
              )}
            </InputGroup>
            <InputGroup>
              <Label htmlFor={timezone.id}>Timezone</Label>
              <Select
                {...getSelectProps(timezone)}
                placeholder="Select a timezone"
                defaultValue={selectedTimezone}
                value={selectedTimezone}
                setValue={(e) => {
                  if (Array.isArray(e)) return;
                  setSelectedTimezone(e);
                }}
                items={possibleTimezones}
                filter={{ keys: [(item) => item.replace(/\//g, " ").replace(/_/g, " ")] }}
                dropdownIcon
                variant="tertiary/medium"
              >
                {(matches) => <TimezoneList timezones={matches} />}
              </Select>
              <Hint>
                {isUtc
                  ? "UTC will not change with daylight savings time."
                  : "This will automatically adjust for daylight savings time."}
              </Hint>
              <FormError id={timezone.errorId}>{timezone.errors}</FormError>
            </InputGroup>
            <InputGroup>
              <Label required={false} htmlFor={scheduleWindow.id}>
                Window
              </Label>
              <Input
                {...getInputProps(scheduleWindow, { type: "text" })}
                placeholder="30m or 25%"
                value={scheduleWindowValue}
                aria-invalid={scheduleWindowResult?.isValid === false ? true : undefined}
                aria-describedby={
                  scheduleWindowResult === undefined ? undefined : scheduleWindow.errorId
                }
                onChange={(event) => setScheduleWindowValue(event.target.value)}
              />
              {scheduleWindowResult === undefined ? (
                <ScheduleWindowHint
                  defaultWindowDurationSeconds={defaultWindowDurationSeconds}
                  minimumWindowDurationSeconds={minimumWindowDurationSeconds}
                />
              ) : scheduleWindowResult.isValid ? (
                <ValidationMessage
                  id={scheduleWindow.errorId}
                  isValid={true}
                  validLabel="Valid window:"
                  invalidLabel="Invalid window:"
                  message={
                    minimumWindowApplied
                      ? `Runs use this window; the Free plan minimum of ${Math.round(
                          minimumWindowDurationSeconds! / 60
                        )} minutes will be applied.`
                      : "Runs will be assigned a stable time within this window."
                  }
                />
              ) : (
                <ValidationMessage
                  id={scheduleWindow.errorId}
                  isValid={false}
                  validLabel="Valid window:"
                  invalidLabel="Invalid window:"
                  message={scheduleWindowResult.error}
                />
              )}
            </InputGroup>
            {nextRuns !== undefined && (
              <div className="flex flex-col gap-1">
                <Header3>Next 5 runs</Header3>
                {scheduleWindowValue !== "" && (
                  <Hint>
                    Actual run times will get a fixed offset based on the window, displayed after
                    creation.
                  </Hint>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      {!isUtc && <TableHeaderCell>{selectedTimezone}</TableHeaderCell>}
                      <TableHeaderCell>UTC</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nextRuns.map((run, index) => (
                      <TableRow key={index}>
                        {!isUtc && (
                          <TableCell>
                            <DateTime date={run} timeZone={selectedTimezone} />
                          </TableCell>
                        )}
                        <TableCell>
                          <DateTime date={run} timeZone="UTC" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <InputGroup>
              <Label>Environment</Label>
              <div className="flex flex-wrap items-center gap-2">
                {/* This first condition supports old schedules where we let you have multiple environments */}
                {schedule && schedule?.environments.length > 1 ? (
                  possibleEnvironments.map((environment) => (
                    <CheckboxWithLabel
                      key={environment.id}
                      id={environment.id}
                      value={environment.id}
                      name="environments"
                      type="radio"
                      label={
                        <span
                          className={cn("text-xs uppercase", environmentTextClassName(environment))}
                        >
                          {environmentTitle(environment, environment.userName)}
                        </span>
                      }
                      defaultChecked={schedule?.environments.some(
                        (scheduledEnvironment) => scheduledEnvironment.id === environment.id
                      )}
                      variant="button"
                    />
                  ))
                ) : (
                  <>
                    <input type="hidden" name="environments" value={environment.id} />
                    <EnvironmentCombo environment={environment} />
                  </>
                )}
              </div>
              {environment.type === "DEVELOPMENT" && (
                <Hint>
                  Note that scheduled tasks in dev environments will only run while you are
                  connected with the dev CLI.
                </Hint>
              )}
              <FormError id={environments.errorId}>{environments.errors}</FormError>
            </InputGroup>
            <InputGroup>
              <Label required={false} htmlFor={externalId.id}>
                External ID
              </Label>
              <Input
                {...getInputProps(externalId, { type: "text" })}
                placeholder="Optionally specify your own ID, e.g. user id"
                defaultValue={schedule?.externalId ?? undefined}
              />
              <Hint>
                Optionally, you can specify your own IDs (like a user ID) and then use it inside the
                run function of your task. This allows you to have per-user CRON tasks.{" "}
                <TextLink to={docsPath("v3/tasks-scheduled")}>Read the docs.</TextLink>
              </Hint>
              <FormError id={externalId.errorId}>{externalId.errors}</FormError>
            </InputGroup>
            <InputGroup>
              <Label required={false} htmlFor={deduplicationKey.id}>
                Deduplication key
              </Label>
              <Input
                {...getInputProps(deduplicationKey, { type: "text" })}
                disabled={schedule !== undefined}
                defaultValue={
                  schedule?.userProvidedDeduplicationKey ? schedule?.deduplicationKey : undefined
                }
              />
              {schedule && (
                <Paragraph variant="small">
                  You can't edit the Deduplication key on an existing schedule.
                </Paragraph>
              )}
              <Hint>
                Optionally specify a key, you can only create one schedule with this key. This is
                very useful when using the SDK and you don't want to create duplicate schedules for
                a user.
              </Hint>
              <FormError id={deduplicationKey.errorId}>{deduplicationKey.errors}</FormError>
            </InputGroup>
            <FormError>{form.errors}</FormError>
          </Fieldset>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2 py-2">
        <div className="flex items-center gap-4">
          {onCancel ? (
            <Button variant="secondary/small" onClick={onCancel} type="button">
              Cancel
            </Button>
          ) : (
            <LinkButton
              to={`${v3EnvironmentPath(organization, project, environment)}${location.search}`}
              variant="secondary/small"
            >
              Cancel
            </LinkButton>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Button
            variant="primary/small"
            type="submit"
            disabled={isLoading}
            shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
            LeadingIcon={isLoading ? Spinner : undefined}
          >
            {buttonText(mode, isLoading)}
          </Button>
        </div>
      </div>
    </FormComponent>
  );
}

function ScheduleWindowHint({
  defaultWindowDurationSeconds,
  minimumWindowDurationSeconds,
}: {
  defaultWindowDurationSeconds?: number | null;
  minimumWindowDurationSeconds?: number | null;
}) {
  const defaultMinutes = defaultWindowDurationSeconds
    ? Math.round(defaultWindowDurationSeconds / 60)
    : undefined;
  const minimumMinutes = minimumWindowDurationSeconds
    ? Math.round(minimumWindowDurationSeconds / 60)
    : undefined;

  if (defaultMinutes && minimumMinutes) {
    return (
      <Hint>
        Leaving this blank applies the {defaultMinutes}-minute default window. Free plan schedules
        must run at least {minimumMinutes} minutes apart and always use a window of at least{" "}
        {minimumMinutes} minutes.
      </Hint>
    );
  }

  if (minimumMinutes) {
    return (
      <Hint>
        Free plan schedules must run at least {minimumMinutes} minutes apart and always use at least
        a {minimumMinutes}-minute window. Smaller values are raised to this minimum.
      </Hint>
    );
  }

  if (defaultMinutes) {
    return (
      <Hint>
        Leaving this blank applies the {defaultMinutes}-minute default window. Enter a value to
        override it, or <code>0m</code> to use the one-minute minimum.
      </Hint>
    );
  }

  return (
    <Hint>
      Assigns each run a stable time after its CRON time, capped at the next CRON occurrence. Use
      minutes, hours, or a percentage of the interval. Every schedule gets at least a one-minute
      spread; enter <code>0m</code> for that minimum.
    </Hint>
  );
}

function buttonText(mode: "edit" | "new", isLoading: boolean) {
  switch (mode) {
    case "edit":
      return isLoading ? "Updating schedule" : "Update schedule";
    case "new":
      return isLoading ? "Creating schedule" : "Create schedule";
  }
}

function ValidationMessage({
  id,
  isValid,
  validLabel,
  invalidLabel,
  message,
}: {
  id?: string;
  isValid: boolean;
  validLabel: string;
  invalidLabel: string;
  message: string;
}) {
  return (
    <Paragraph id={id} variant="small">
      <span className="mr-1">
        {isValid ? (
          <CheckIcon className="-mt-0.5 mr-1 inline-block h-4 w-4 text-success" />
        ) : (
          <XMarkIcon className="-mt-0.5 mr-1 inline-block h-4 w-4 text-error" />
        )}
        <span className={isValid ? "text-success" : "text-error"}>
          {isValid ? validLabel : invalidLabel}
        </span>
      </span>
      <span>{message}</span>
    </Paragraph>
  );
}
