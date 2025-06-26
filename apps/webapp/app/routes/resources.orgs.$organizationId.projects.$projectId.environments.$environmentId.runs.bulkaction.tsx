import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { XCircleIcon } from "@heroicons/react/24/outline";
import { Form, useActionData, useFetcher } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/router";
import { useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Header2 } from "~/components/primitives/Headers";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
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
import { v3RunsNextPath, v3RunsPath } from "~/utils/pathBuilder";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Hint } from "~/components/primitives/Hint";
import { RadioGroupItem, RadioGroup } from "~/components/primitives/RadioButton";
import { formatNumber } from "~/utils/numberFormatter";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { formatDateTime } from "~/components/primitives/DateTime";

const Params = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
});

const searchParams = z.object({
  mode: z.union([z.literal("selected"), z.literal("filter")]).default("filter"),
  action: z.union([z.literal("cancel"), z.literal("replay")]).default("cancel"),
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
  const { value } = useSearchParams();
  const location = useOptimisticLocation();

  useEffect(() => {
    fetcher.load(
      `/resources/orgs/${organization.id}/projects/${project.id}/environments/${environment.id}/runs/bulkaction${location.search}`
    );
  }, [organization.id, project.id, environment.id, location.search]);

  const mode = value("mode") ?? "filter";
  const action = value("action") ?? "replay";

  const data = fetcher.data != null ? fetcher.data : undefined;

  const formattedFilteredRunsCount =
    data?.count !== undefined ? (
      `~${formatNumber(data.count)}`
    ) : (
      <SpinnerWhite className="mx-0.5 -mt-0.5 inline size-3" />
    );

  const closedSearchParams = new URLSearchParams(location.search);
  closedSearchParams.delete("bulkInspector");

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
            to={`${v3RunsNextPath(
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
          <Fieldset className="p-3">
            <InputGroup>
              <Label htmlFor="mode">Select</Label>
              <RadioGroup
                name="mode"
                className="flex flex-col items-start gap-2"
                defaultValue={mode}
              >
                <RadioGroupItem
                  id="mode-filter"
                  label={<span>All {formattedFilteredRunsCount} runs matching your filters</span>}
                  value={"filter"}
                  variant="button/small"
                />
                <RadioGroupItem
                  id="mode-selected"
                  label={`${selectedItems.size} individually selected runs`}
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
          >
            {action === "replay" ? (
              <span className="text-text-bright">Replay {formattedFilteredRunsCount} runs…</span>
            ) : (
              <span className="text-text-bright">Cancel {formattedFilteredRunsCount} runs…</span>
            )}
          </Button>
        </div>
      </div>
    </Form>
  );
}
