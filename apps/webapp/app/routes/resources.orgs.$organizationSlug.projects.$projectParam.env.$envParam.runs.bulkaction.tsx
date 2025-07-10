import { parse } from "@conform-to/zod";
import { ArrowPathIcon, CheckIcon } from "@heroicons/react/20/solid";
import { XCircleIcon } from "@heroicons/react/24/outline";
import { Form } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/router";
import { tryCatch } from "@trigger.dev/core";
import { type TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { useEffect, useState } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import {
  filterIcon,
  filterTitle,
  type TaskRunListSearchFilterKey,
  type TaskRunListSearchFilters,
} from "~/components/runs/v3/RunFilters";
import {
  appliedSummary,
  dateFromString,
  timeFilterRenderValues,
} from "~/components/runs/v3/SharedFilters";
import { runStatusTitle } from "~/components/runs/v3/TaskRunStatus";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useUser } from "~/hooks/useUser";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { CreateBulkActionPresenter } from "~/presenters/v3/CreateBulkActionPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { EnvironmentParamSchema, v3BulkActionPath, v3RunsPath } from "~/utils/pathBuilder";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  const presenter = new CreateBulkActionPresenter();
  const data = await presenter.call({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    request,
  });

  return typedjson(data);
}

const BulkActionMode = z.union([z.literal("selected"), z.literal("filter")]);
type BulkActionMode = z.infer<typeof BulkActionMode>;
const BulkActionAction = z.union([z.literal("cancel"), z.literal("replay")]);
type BulkActionAction = z.infer<typeof BulkActionAction>;

export const CreateBulkActionSearchParams = z.object({
  mode: BulkActionMode.default("filter"),
  action: BulkActionAction.default("cancel"),
});

export const CreateBulkActionPayload = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("selected"),
    action: BulkActionAction,
    selectedRunIds: z.array(z.string()),
    title: z.string().optional(),
    failedRedirect: z.string(),
    emailNotification: z.preprocess((value) => value === "on", z.boolean()),
  }),
  z.object({
    mode: z.literal("filter"),
    action: BulkActionAction,
    title: z.string().optional(),
    failedRedirect: z.string(),
    emailNotification: z.preprocess((value) => value === "on", z.boolean()),
  }),
]);
export type CreateBulkActionPayload = z.infer<typeof CreateBulkActionPayload>;

export async function action({ params, request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema: CreateBulkActionPayload });

  if (!submission.value) {
    logger.error("Invalid bulk action", {
      submission,
      formData: Object.fromEntries(formData),
    });
    return redirectWithErrorMessage("/", request, "Invalid bulk action");
  }

  const service = new BulkActionService();
  const [error, result] = await tryCatch(
    service.create(
      project.organizationId,
      project.id,
      environment.id,
      userId,
      submission.value,
      request
    )
  );

  if (error) {
    logger.error("Failed to create bulk action", {
      error,
    });

    return redirectWithErrorMessage(
      submission.value.failedRedirect,
      request,
      `Failed to create bulk action: ${error.message}`
    );
  }

  return redirectWithSuccessMessage(
    v3BulkActionPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { friendlyId: result.bulkActionId }
    ),
    request,
    "Bulk action started"
  );
}

export function CreateBulkActionInspector({
  filters,
  selectedItems,
}: {
  filters: TaskRunListSearchFilters;
  selectedItems: Set<string>;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();
  const { value, replace } = useSearchParams();
  const location = useOptimisticLocation();
  const user = useUser();

  useEffect(() => {
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/bulkaction${location.search}`
    );
  }, [organization.id, project.id, environment.id, location.search]);

  const mode = value("mode") ?? "filter";
  const action = value("action") ?? "replay";

  const data = fetcher.data != null ? fetcher.data : undefined;

  const closedSearchParams = new URLSearchParams(location.search);
  closedSearchParams.delete("bulkInspector");

  const impactedCountElement =
    mode === "selected" ? selectedItems.size : <EstimatedCount count={data?.count} />;
  const impactedCount = mode === "selected" ? selectedItems.size : data?.count ?? 0;

  return (
    <Form
      method="post"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/bulkaction${location.search}`}
      className="h-full"
      id="bulk-action-form"
    >
      <input type="hidden" name="failedRedirect" value={`${location.pathname}${location.search}`} />
      <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
        <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
          <Header2 className="whitespace-nowrap">Create a bulk action</Header2>
          <LinkButton
            to={`${v3RunsPath(
              organization,
              project,
              environment
            )}?${closedSearchParams.toString()}`}
            variant="minimal/medium"
            TrailingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
            shortcutPosition="before-trailing-icon"
            className="pl-1"
          />
        </div>
        <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <Fieldset className="p-3">
            {Array.from(selectedItems).map((runId) => {
              return <input key={runId} type="hidden" name="selectedRunIds" value={runId} />;
            })}
            <InputGroup>
              <Label htmlFor="mode">Select</Label>
              <RadioGroup
                name="mode"
                className="flex flex-col items-start gap-2"
                defaultValue={mode}
                onValueChange={(value) => {
                  replace({ mode: value });
                }}
              >
                <RadioGroupItem
                  id="mode-filter"
                  label={
                    <span>
                      {data?.count === 0 ? "" : "All"} <EstimatedCount count={data?.count} /> runs
                      matching your filters
                    </span>
                  }
                  value={"filter"}
                  variant="button/small"
                />
                <RadioGroupItem
                  id="mode-selected"
                  label={simplur`${selectedItems.size} individually selected run[|s]`}
                  value={"selected"}
                  variant="button/small"
                  className="grow"
                />
              </RadioGroup>
            </InputGroup>
            <InputGroup>
              <Label htmlFor="title">Name</Label>
              <Input name="title" placeholder="A name for this bulk action" autoComplete="off" />
              <Hint>Add a name to identify this bulk action (optional).</Hint>
            </InputGroup>
            <InputGroup>
              <Label htmlFor="action">Bulk action to perform</Label>
              <RadioGroup
                name="action"
                className="flex flex-col items-start gap-2"
                defaultValue={action}
                onValueChange={(value) => {
                  replace({ action: value });
                }}
              >
                <RadioGroupItem
                  id="action-replay"
                  label={
                    <span className="inline-flex items-center gap-1">
                      <ArrowPathIcon className="mb-0.5 size-4 text-blue-400" /> Replay runs
                    </span>
                  }
                  description="Replays all selected runs, regardless of current status."
                  value={"replay"}
                  variant="description"
                />
                <RadioGroupItem
                  id="action-cancel"
                  label={
                    <span className="inline-flex items-center gap-1">
                      <XCircleIcon className="mb-0.5 size-4 text-error" /> Cancel runs
                    </span>
                  }
                  description="Cancels all runs still in progress. Any finished runs won’t be canceled."
                  value={"cancel"}
                  variant="description"
                />
              </RadioGroup>
            </InputGroup>
            <InputGroup>
              <Label>Preview</Label>
              <BulkActionPreview
                selected={mode === "selected" ? selectedItems.size : data?.count}
                mode={mode as BulkActionMode}
                action={action as BulkActionAction}
                filters={filters}
              />
            </InputGroup>
          </Fieldset>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed px-2">
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="secondary/medium"
                LeadingIcon={action === "replay" ? ArrowPathIcon : XCircleIcon}
                leadingIconClassName={cn(
                  "w-[1.3rem] h-[1.3rem]",
                  action === "replay" ? "text-blue-400" : "text-error"
                )}
                shortcut={{
                  modifiers: ["meta"],
                  key: "enter",
                  enabledOnInputElements: true,
                }}
                disabled={impactedCountElement === 0}
              >
                {action === "replay" ? (
                  <span className="text-text-bright">Replay {impactedCountElement} runs…</span>
                ) : (
                  <span className="text-text-bright">Cancel {impactedCountElement} runs…</span>
                )}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>{action === "replay" ? "Replay runs" : "Cancel runs"}</DialogHeader>
              <div className="flex flex-col gap-3 divide-y divide-grid-dimmed pt-2">
                <BulkActionPreview
                  selected={mode === "selected" ? selectedItems.size : data?.count}
                  mode={mode as BulkActionMode}
                  action={action as BulkActionAction}
                  filters={filters}
                />
                <Paragraph variant="small" className="pt-3">
                  {action === "replay"
                    ? "All matching runs will be replayed."
                    : "Runs that are still in progress will be canceled. If a run finishes before this bulk action processes it, it can’t be canceled."}
                </Paragraph>
                <div className="pt-3">
                  <CheckboxWithLabel
                    name="emailNotification"
                    variant="simple/small"
                    label={`Email me when it finishes (${user.email})`}
                    form="bulk-action-form"
                    defaultChecked={false}
                    value="on"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="tertiary/medium"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Close
                </Button>
                <Button
                  type="submit"
                  form="bulk-action-form"
                  variant={action === "replay" ? "primary/medium" : "danger/medium"}
                  disabled={impactedCountElement === 0}
                >
                  {action === "replay" ? (
                    <span className="text-text-bright">Replay {impactedCountElement} runs</span>
                  ) : (
                    <span className="text-text-bright">Cancel {impactedCountElement} runs</span>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </Form>
  );
}

function BulkActionPreview({
  selected,
  mode,
  action,
  filters,
}: {
  selected?: number;
  mode: BulkActionMode;
  action: BulkActionAction;
  filters: TaskRunListSearchFilters;
}) {
  switch (mode) {
    case "selected":
      return (
        <Paragraph variant="small">
          You have individually selected {simplur`${selected} run[|s]`} to be{" "}
          <Action action={action} />.
        </Paragraph>
      );
    case "filter": {
      const { label, valueLabel, rangeType } = timeFilterRenderValues({
        from: filters.from ? dateFromString(`${filters.from}`) : undefined,
        to: filters.to ? dateFromString(`${filters.to}`) : undefined,
        period: filters.period,
      });

      return (
        <div className="flex flex-col gap-2">
          <Paragraph variant="small">
            You have selected{" "}
            <span className="text-text-bright">
              <EstimatedCount count={selected} />
            </span>{" "}
            runs to be <Action action={action} /> using these filters:
          </Paragraph>
          <div className="flex flex-col gap-2">
            <AppliedFilter
              variant="minimal/medium"
              label={label}
              icon={filterIcon("period")}
              value={valueLabel}
              removable={false}
            />
            {Object.entries(filters).map(([key, value]) => {
              if (!value && key !== "period") {
                return null;
              }

              const typedKey = key as TaskRunListSearchFilterKey;

              switch (typedKey) {
                case "cursor":
                case "direction":
                case "environments":
                //We need to handle time differently because we have a default
                case "period":
                case "from":
                case "to": {
                  return null;
                }
                case "tasks": {
                  const values = Array.isArray(value) ? value : [`${value}`];
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={filterTitle(key)}
                      icon={filterIcon(key)}
                      value={appliedSummary(values)}
                      removable={false}
                    />
                  );
                }
                case "versions": {
                  const values = Array.isArray(value) ? value : [`${value}`];
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={filterTitle(key)}
                      icon={filterIcon(key)}
                      value={appliedSummary(values)}
                      removable={false}
                    />
                  );
                }
                case "statuses": {
                  const values = Array.isArray(value) ? value : [`${value}`];
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={filterTitle(key)}
                      icon={filterIcon(key)}
                      value={appliedSummary(values.map((v) => runStatusTitle(v as TaskRunStatus)))}
                      removable={false}
                    />
                  );
                }
                case "tags": {
                  const values = Array.isArray(value) ? value : [`${value}`];
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={filterTitle(key)}
                      icon={filterIcon(key)}
                      value={appliedSummary(values)}
                      removable={false}
                    />
                  );
                }
                case "bulkId": {
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={filterTitle(key)}
                      icon={filterIcon(key)}
                      value={value}
                      removable={false}
                    />
                  );
                }
                case "rootOnly": {
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={"Root only"}
                      icon={filterIcon(key)}
                      value={
                        value ? (
                          <CheckIcon className="size-4" />
                        ) : (
                          <XCircleIcon className="size-4" />
                        )
                      }
                      removable={false}
                    />
                  );
                }
                case "runId": {
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={"Run ID"}
                      icon={filterIcon(key)}
                      value={value}
                      removable={false}
                    />
                  );
                }
                case "batchId": {
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={"Batch ID"}
                      icon={filterIcon(key)}
                      value={value}
                      removable={false}
                    />
                  );
                }
                case "scheduleId": {
                  return (
                    <AppliedFilter
                      variant="minimal/medium"
                      key={key}
                      label={"Schedule ID"}
                      icon={filterIcon(key)}
                      value={value}
                      removable={false}
                    />
                  );
                }
                default: {
                  assertNever(typedKey);
                }
              }
            })}
          </div>
        </div>
      );
    }
  }
}

function Action({ action }: { action: BulkActionAction }) {
  switch (action) {
    case "cancel":
      return (
        <span>
          <XCircleIcon className="mb-0.5 inline-block size-4 text-error" />
          <span className="ml-0.5 text-text-bright">Canceled</span>
        </span>
      );
    case "replay":
      return (
        <span>
          <ArrowPathIcon className="mb-0.5 inline-block size-4 text-blue-400" />
          <span className="ml-0.5 text-text-bright">Replayed</span>
        </span>
      );
  }
}

function EstimatedCount({ count }: { count?: number }) {
  if (typeof count === "number") {
    return <>~{formatNumber(count)}</>;
  }

  return <SpinnerWhite className="mx-0.5 -mt-0.5 inline size-3" />;
}
