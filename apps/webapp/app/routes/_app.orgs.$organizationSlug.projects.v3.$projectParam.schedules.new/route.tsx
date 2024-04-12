import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { parseExpression } from "cron-parser";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath, v3SchedulesPath } from "~/utils/pathBuilder";
import { UpsertTaskScheduleService } from "~/v3/services/createTaskSchedule";
import cronstrue from "cronstrue";
import { useState } from "react";
import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { logger } from "~/services/logger.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const presenter = new EditSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
  });

  return typedjson(result);
};

const CreateSchedule = z.object({
  taskIdentifier: z.string().min(1, "Task is required"),
  cron: z.string().refine(
    (val) => {
      try {
        parseExpression(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    (val) => {
      try {
        parseExpression(val);
        return {
          message: "Unknown problem",
        };
      } catch (e) {
        return { message: e instanceof Error ? e.message : JSON.stringify(e) };
      }
    }
  ),
  environments: z.preprocess(
    (data) => (typeof data === "string" ? [data] : data),
    z.array(z.string()).min(1, "At least one environment is required")
  ),
  externalId: z.string().optional(),
  deduplicationKey: z.string().optional(),
});

export type CreateSchedule = z.infer<typeof CreateSchedule>;

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: CreateSchedule });

  logger.log("CreateSchedule", { submission });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const project = await prisma.project.findUnique({
      where: { slug: projectParam },
      select: { id: true },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const createSchedule = new UpsertTaskScheduleService();
    const result = await createSchedule.call({
      projectId: project.id,
      userId,
      scheduleFriendlyId: undefined,
      ...submission.value,
    });

    return redirectWithSuccessMessage(
      v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }),
      request,
      "Schedule created"
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
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

export default function Page() {
  const { schedule, possibleTasks, possibleEnvironments } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const lastSubmission = useActionData();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const location = useLocation();
  const [cronPattern, setCronPattern] = useState<string>(schedule?.cron ?? "");

  const [form, { taskIdentifier, cron, externalId, environments, deduplicationKey }] = useForm({
    id: "create-schedule",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, { schema: CreateSchedule });
    },
  });

  let cronPatternResult: CronPatternResult | undefined = undefined;
  if (cronPattern !== "") {
    try {
      parseExpression(cronPattern);
      cronPatternResult = {
        isValid: true,
        description: cronstrue.toString(cronPattern),
      };
    } catch (e) {
      cronPatternResult = {
        isValid: false,
        error: e instanceof Error ? e.message : JSON.stringify(e),
      };
    }
  }

  return (
    <Form
      method="post"
      {...form.props}
      className="grid h-full max-h-full grid-rows-[2.5rem_1fr_2.5rem] overflow-hidden bg-background-bright"
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>New schedule</Header2>
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="p-3">
          <Fieldset>
            <InputGroup>
              <Label htmlFor={taskIdentifier.id}>Task</Label>
              <SelectGroup>
                <Select
                  {...conform.input(taskIdentifier, { type: "select" })}
                  defaultValue={schedule?.taskIdentifier}
                >
                  <SelectTrigger size="medium" width="full">
                    <SelectValue placeholder="Select task" className="ml-2 p-0" />
                  </SelectTrigger>
                  <SelectContent>
                    {possibleTasks.map((task) => (
                      <SelectItem key={task} value={task}>
                        <Paragraph
                          variant="extra-small"
                          className="pl-0.5 transition group-hover:text-text-bright"
                        >
                          {task}
                        </Paragraph>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SelectGroup>
              <FormError id={taskIdentifier.errorId}>{taskIdentifier.error}</FormError>
            </InputGroup>
            <InputGroup>
              <Label htmlFor={cron.id}>CRON pattern</Label>
              <Input
                {...conform.input(cron, { type: "text" })}
                placeholder="? ? ? ? ?"
                required={true}
                value={cronPattern}
                onChange={(e) => {
                  setCronPattern(e.target.value);
                }}
              />
              {cron.error ? (
                <FormError id={cron.errorId}>{cron.error}</FormError>
              ) : cronPatternResult === undefined ? (
                <Hint>Enter a CRON pattern or use natural language above.</Hint>
              ) : cronPatternResult.isValid ? (
                <ValidCronMessage isValid={true} message={`${cronPatternResult.description}.`} />
              ) : (
                <ValidCronMessage isValid={false} message={cronPatternResult.error} />
              )}
            </InputGroup>
            <InputGroup>
              <Label>Environments</Label>
              <div className="flex flex-wrap items-center gap-2">
                {possibleEnvironments.map((environment) => (
                  <Checkbox
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
                ))}
              </div>
              <Hint>Select all the environments where you want this schedule to run.</Hint>
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
                defaultValue={
                  schedule?.userProvidedDeduplicationKey ? schedule?.deduplicationKey : undefined
                }
              />
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
            to={`${v3SchedulesPath(organization, project)}${location.search}`}
            variant="minimal/small"
          >
            Cancel
          </LinkButton>
        </div>
        <div className="flex items-center gap-4">
          <Button
            variant="primary/small"
            type="submit"
            disabled={isLoading}
            LeadingIcon={isLoading ? "spinner" : undefined}
          >
            {isLoading ? "Creating schedule" : "Create schedule"}
          </Button>
        </div>
      </div>
    </Form>
  );
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
