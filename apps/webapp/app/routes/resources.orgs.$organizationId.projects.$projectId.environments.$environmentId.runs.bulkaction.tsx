import { ArrowPathIcon, CheckIcon } from "@heroicons/react/20/solid";
import { XCircleIcon } from "@heroicons/react/24/outline";
import { Form } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/router";
import { type TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { filter } from "compression";
import { useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button, LinkButton } from "~/components/primitives/Buttons";
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
import { $replica, type PrismaClient } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { RunsRepository } from "~/services/runsRepository.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { v3RunsPath } from "~/utils/pathBuilder";

const Params = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
});

const BulkActionMode = z.union([z.literal("selected"), z.literal("filter")]);
type BulkActionMode = z.infer<typeof BulkActionMode>;
const BulkActionAction = z.union([z.literal("cancel"), z.literal("replay")]);
type BulkActionAction = z.infer<typeof BulkActionAction>;

const searchParams = z.object({
  mode: BulkActionMode.default("filter"),
  action: BulkActionAction.default("cancel"),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationId, projectId, environmentId } = Params.parse(params);
  const filters = await getRunFiltersFromRequest(request);
  const { mode, action } = searchParams.parse(
    Object.fromEntries(new URL(request.url).searchParams)
  );

  //todo do a ClickHouse Query with the filters
  if (!clickhouseClient) {
    throw new Error("Clickhouse client not found");
  }

  const runsRepository = new RunsRepository({
    clickhouse: clickhouseClient,
    prisma: $replica as PrismaClient,
  });

  const count = await runsRepository.countRuns({
    organizationId,
    projectId,
    environmentId,
    ...filters,
  });

  return typedjson({
    filters,
    mode,
    action,
    count,
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const { organizationId, projectId, environmentId } = Params.parse(params);
  const filters = await getRunFiltersFromRequest(request);

  return redirectWithSuccessMessage("/", request, "SORTED");
}

export function CreateBulkActionInspector({
  filters,
  selectedItems,
}: {
  filters: TaskRunListSearchFilters;
  selectedItems: Set<string>;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();
  const { value, replace } = useSearchParams();
  const location = useOptimisticLocation();

  useEffect(() => {
    fetcher.load(
      `/resources/orgs/${organization.id}/projects/${project.id}/environments/${environment.id}/runs/bulkaction${location.search}`
    );
  }, [organization.id, project.id, environment.id, location.search]);

  const mode = value("mode") ?? "filter";
  const action = value("action") ?? "replay";

  const data = fetcher.data != null ? fetcher.data : undefined;

  const closedSearchParams = new URLSearchParams(location.search);
  closedSearchParams.delete("bulkInspector");

  const impactedCount =
    mode === "selected" ? selectedItems.size : <EstimatedCount count={data?.count} />;

  return (
    <Form
      method="post"
      action={`/resources/orgs/${organization.id}/projects/${project.id}/environments/${environment.id}/runs/bulkaction${location.search}`}
      className="h-full"
    >
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
              <Label htmlFor="name">Name</Label>
              <Input name="name" placeholder="A name for this bulk action" autoComplete="off" />
              <Hint>Add a name to identify this bulk action (optional).</Hint>
              {/* todo <FormError id={name.errorId}>{name.error}</FormError> */}
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
          <Button
            type="submit"
            variant="tertiary/medium"
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
            disabled={impactedCount === 0}
          >
            {action === "replay" ? (
              <span className="text-text-bright">Replay {impactedCount} runs…</span>
            ) : (
              <span className="text-text-bright">Cancel {impactedCount} runs…</span>
            )}
          </Button>
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
