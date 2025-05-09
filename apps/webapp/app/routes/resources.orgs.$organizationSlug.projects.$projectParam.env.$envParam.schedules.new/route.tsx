import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseExpression } from "cron-parser";
import cronstrue from "cronstrue";
import { useRef, useState } from "react";
import {
  environmentTextClassName,
  environmentTitle,
  EnvironmentCombo,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { EditableScheduleElements } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  ProjectParamSchema,
  docsPath,
  v3SchedulesPath,
} from "~/utils/pathBuilder";
import { CronPattern, UpsertSchedule } from "~/v3/schedules";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";
import { AIGeneratedCronField } from "../resources.orgs.$organizationSlug.projects.$projectParam.schedules.new.natural-language";
import { TimezoneList } from "~/components/scheduled/timezones";
import { logger } from "~/services/logger.server";
import { Spinner } from "~/components/primitives/Spinner";
import { cond } from "effect/STM";
import { useEnvironment } from "~/hooks/useEnvironment";

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
  const submission = parse(formData, { schema: UpsertSchedule });

  if (!submission.value) {
    return json(submission);
  }

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

    return redirectWithSuccessMessage(
      v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
      request,
      submission.value?.friendlyId === result.id ? "Schedule updated" : "Schedule created"
    );
  } catch (error: any) {
    logger.error("Failed to create schedule", error);

    const errorMessage = `Something went wrong. Please try again.`;
    return redirectWithErrorMessage(
      v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
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
    };

export function UpsertScheduleForm({
  schedule,
  possibleTasks,
  possibleEnvironments,
  possibleTimezones,
  showGenerateField,
}: EditableScheduleElements & { showGenerateField: boolean }) {
  const lastSubmission = useActionData();
  const [selectedTimezone, setSelectedTimezone] = useState<string>(schedule?.timezone ?? "UTC");
  const isUtc = selectedTimezone === "UTC";
  const [cronPattern, setCronPattern] = useState<string>(schedule?.cron ?? "");
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();

  const [form, { taskIdentifier, cron, timezone, externalId, environments, deduplicationKey }] =
    useForm({
      id: "create-schedule",
      // TODO: type this
      lastSubmission: lastSubmission as any,
      shouldRevalidate: "onSubmit",
      onValidate({ formData }) {
        return parse(formData, { schema: UpsertSchedule });
      },
    });

  let cronPatternResult: CronPatternResult | undefined = undefined;
  let nextRuns: Date[] | undefined = undefined;

  if (cronPattern !== "") {
    const result = CronPattern.safeParse(cronPattern);

    if (!result.success) {
      cronPatternResult = {
        isValid: false,
        error: result.error.errors[0].message,
      };
    } else {
      try {
        const expression = parseExpression(
          cronPattern,
          isUtc ? { utc: true } : { tz: selectedTimezone }
        );
        cronPatternResult = {
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

  const mode = schedule ? "edit" : "new";

  return (
    <Form
      method="post"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/schedules/new`}
      {...form.props}
      className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright"
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>
          {schedule?.friendlyId ? "Edit schedule" : "New schedule"}
        </Header2>
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="p-3">
          {schedule && <input type="hidden" name="friendlyId" value={schedule.friendlyId} />}
          <Fieldset>
            <InputGroup>
              <Label htmlFor={taskIdentifier.id}>Task</Label>
              <Select
                {...conform.select(taskIdentifier)}
                placeholder="Select a task"
                defaultValue={schedule?.taskIdentifier}
                heading={"Filter..."}
                items={possibleTasks}
                filter={(task, search) => task.toLowerCase().includes(search.toLowerCase())}
                dropdownIcon
                variant="tertiary/medium"
              >
                {(matches) => (
                  <>
                    {matches?.map((task) => (
                      <SelectItem key={task} value={task}>
                        {task}
                      </SelectItem>
                    ))}
                  </>
                )}
              </Select>
              <FormError id={taskIdentifier.errorId}>{taskIdentifier.error}</FormError>
            </InputGroup>
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
                {...conform.input(cron, { type: "text" })}
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
                <ValidCronMessage isValid={true} message={`${cronPatternResult.description}.`} />
              ) : (
                <ValidCronMessage isValid={false} message={cronPatternResult.error} />
              )}
            </InputGroup>
            <InputGroup>
              <Label htmlFor={timezone.id}>Timezone</Label>
              <Select
                {...conform.select(timezone)}
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
              <FormError id={timezone.errorId}>{timezone.error}</FormError>
            </InputGroup>
            {nextRuns !== undefined && (
              <div className="flex flex-col gap-1">
                <Header3>Next 5 runs</Header3>
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
                      defaultChecked={
                        schedule?.instances.find((i) => i.environmentId === environment.id) !==
                        undefined
                      }
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
              <FormError id={environments.errorId}>{environments.error}</FormError>
            </InputGroup>
            <InputGroup>
              <Label required={false} htmlFor={externalId.id}>
                External ID
              </Label>
              <Input
                {...conform.input(externalId, { type: "text" })}
                placeholder="Optionally specify your own ID, e.g. user id"
                defaultValue={schedule?.externalId ?? undefined}
              />
              <Hint>
                Optionally, you can specify your own IDs (like a user ID) and then use it inside the
                run function of your task. This allows you to have per-user CRON tasks.{" "}
                <TextLink to={docsPath("v3/tasks-scheduled")}>Read the docs.</TextLink>
              </Hint>
              <FormError id={externalId.errorId}>{externalId.error}</FormError>
            </InputGroup>
            <InputGroup>
              <Label required={false} htmlFor={deduplicationKey.id}>
                Deduplication key
              </Label>
              <Input
                {...conform.input(deduplicationKey, { type: "text" })}
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
              <FormError id={deduplicationKey.errorId}>{deduplicationKey.error}</FormError>
            </InputGroup>
            <FormError>{form.error}</FormError>
          </Fieldset>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
        <div className="flex items-center gap-4">
          <LinkButton
            to={`${v3SchedulesPath(organization, project, environment)}${location.search}`}
            variant="tertiary/medium"
          >
            Cancel
          </LinkButton>
        </div>
        <div className="flex items-center gap-4">
          <Button
            variant="primary/medium"
            type="submit"
            disabled={isLoading}
            shortcut={{ key: "enter", modifiers: ["mod"] }}
            LeadingIcon={isLoading ? Spinner : undefined}
          >
            {buttonText(mode, isLoading)}
          </Button>
        </div>
      </div>
    </Form>
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

function ValidCronMessage({ isValid, message }: { isValid: boolean; message: string }) {
  return (
    <Paragraph variant="small">
      <span className="mr-1">
        {isValid ? (
          <CheckIcon className="-mt-0.5 mr-1 inline-block h-4 w-4 text-success" />
        ) : (
          <XMarkIcon className="-mt-0.5 mr-1 inline-block h-4 w-4 text-error" />
        )}
        <span className={isValid ? "text-success" : "text-error"}>
          {isValid ? "Valid pattern:" : "Invalid pattern:"}
        </span>
      </span>
      <span>{message}</span>
    </Paragraph>
  );
}
