import { parse } from "@conform-to/zod";
import { ArrowPathIcon, CheckIcon, InformationCircleIcon } from "@heroicons/react/20/solid";
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
import selectRunsIndividually from "~/assets/images/select-runs-individually.png";
import selectRunsUsingFilters from "~/assets/images/select-runs-using-filters.png";
import {
  BulkActionAction,
  BulkActionFilterSummary,
  BulkActionMode,
  EstimatedCount,
} from "~/components/BulkActionFilterSummary";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
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

export const CreateBulkActionSearchParams = z.object({
  mode: BulkActionMode.default("filter"),
  action: BulkActionAction.default("cancel"),
});

export const CreateBulkActionPayload = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("selected"),
    action: BulkActionAction,
    selectedRunIds: z.preprocess((value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") return [value];
      return [];
    }, z.array(z.string())),
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
  hasBulkActions,
}: {
  filters: TaskRunListSearchFilters;
  selectedItems: Set<string>;
  hasBulkActions: boolean;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();
  const { value, replace } = useSearchParams();
  const [action, setAction] = useState<BulkActionAction>(
    bulkActionActionFromString(value("action"))
  );
  const location = useOptimisticLocation();
  const user = useUser();

  useEffect(() => {
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/bulkaction${location.search}`
    );
  }, [organization.id, project.id, environment.id, location.search]);

  useEffect(() => {
    setAction(bulkActionActionFromString(value("action")));
  }, [value("action")]);

  const mode = bulkActionModeFromString(value("mode"));

  const data = fetcher.data != null ? fetcher.data : undefined;

  const closedSearchParams = new URLSearchParams(location.search);
  closedSearchParams.delete("bulkInspector");

  const impactedCountElement =
    mode === "selected" ? selectedItems.size : <EstimatedCount count={data?.count} />;

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
            variant="minimal/small"
            TrailingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
            shortcutPosition="before-trailing-icon"
            className="pl-1"
          />
        </div>
        <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <div className="px-3 pt-3">
            <Accordion
              type="single"
              collapsible
              defaultValue={!hasBulkActions ? "instructions" : undefined}
            >
              <AccordionItem value="instructions">
                <AccordionTrigger
                  leadingIcon={InformationCircleIcon}
                  leadingIconClassName="text-blue-500"
                >
                  How to create a bulk action
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <Paragraph variant="small">
                      Select runs individually using the checkboxes.
                    </Paragraph>
                    <div>
                      <img src={selectRunsIndividually} alt="Select runs individually" />
                    </div>
                    <Paragraph variant="small">
                      Or select runs using the filter menus on this page.
                    </Paragraph>
                    <div>
                      <img src={selectRunsUsingFilters} alt="Select runs using filters" />
                    </div>
                    <Paragraph variant="small">
                      Then complete the form below and click “Cancel runs” or “Replay runs”.
                    </Paragraph>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
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
                  className="grow tabular-nums"
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
                value={action}
                onValueChange={(value) => {
                  replace({ action: value });
                }}
              >
                <RadioGroupItem
                  id="action-cancel"
                  label={
                    <span className="inline-flex items-center gap-1">
                      <XCircleIcon className="size-4 text-error" /> Cancel runs
                    </span>
                  }
                  description="Cancels all runs still in progress. Any finished runs won’t be canceled."
                  value={"cancel"}
                  variant="description"
                />
                <RadioGroupItem
                  id="action-replay"
                  label={
                    <span className="inline-flex items-center gap-1">
                      <ArrowPathIcon className="size-4 text-blue-400" /> Replay runs
                    </span>
                  }
                  description="Replays all selected runs, regardless of current status."
                  value={"replay"}
                  variant="description"
                />
              </RadioGroup>
            </InputGroup>
            <InputGroup>
              <Label>Preview</Label>
              <BulkActionFilterSummary
                selected={mode === "selected" ? selectedItems.size : data?.count}
                mode={mode}
                action={action}
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
                disabled={impactedCountElement === 0 || isDialogOpen}
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
                <BulkActionFilterSummary
                  selected={mode === "selected" ? selectedItems.size : data?.count}
                  mode={mode}
                  action={action}
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
                  shortcut={{
                    modifiers: ["meta"],
                    key: "enter",
                    enabledOnInputElements: true,
                  }}
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

function bulkActionModeFromString(value: string | undefined): BulkActionMode {
  if (!value) return "filter";
  const parsed = BulkActionMode.safeParse(value);
  if (!parsed.success) return "filter";
  return parsed.data;
}

function bulkActionActionFromString(value: string | undefined): BulkActionAction {
  if (!value) return "cancel";
  const parsed = BulkActionAction.safeParse(value);
  if (!parsed.success) return "cancel";
  return parsed.data;
}
