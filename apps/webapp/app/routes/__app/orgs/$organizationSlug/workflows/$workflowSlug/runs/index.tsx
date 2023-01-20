import { Listbox } from "@headlessui/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useFetcher, useSubmit, useTransition } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Panel } from "~/components/layout/Panel";
import { PanelInfo } from "~/components/layout/PanelInfo";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { PaginationControls } from "~/components/Pagination";
import { TertiaryLink } from "~/components/primitives/Buttons";
import { StyledListBox } from "~/components/primitives/ListBox";
import { Body } from "~/components/primitives/text/Body";
import { Title } from "~/components/primitives/text/Title";
import { RunsTable } from "~/components/runs/RunsTable";
import {
  runStatusIcon,
  runStatusLabel,
  runStatusTitle,
} from "~/components/runs/runStatus";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import type { WorkflowRunStatus } from "~/models/workflowRun.server";
import { WorkflowRunListPresenter } from "~/models/workflowRunListPresenter.server";
import { allStatuses } from "~/models/workflowRunStatus";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");
  invariant(workflowSlug, "workflowSlug is required");

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);

  try {
    const environmentSlug = await getRuntimeEnvironmentFromRequest(request);
    const presenter = new WorkflowRunListPresenter();
    const result = await presenter.data({
      userId,
      organizationSlug,
      workflowSlug,
      environmentSlug,
      searchParams,
    });
    return typedjson(result);
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const result = useTypedLoaderData<typeof loader>();
  const { runs, total, page, pageCount, pageSize, filters, hasFilters } =
    result;

  const fetcher = useFetcher();
  const submit = useSubmit();
  const transition = useTransition();

  const formRef = useRef<HTMLFormElement>(null);

  const submitForm = useCallback(() => {
    if (!formRef.current) return;
    submit(formRef.current, { replace: true });
  }, [submit]);

  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");

  const isLoading =
    transition.state !== "idle" &&
    transition.location.pathname.endsWith("/runs");

  return (
    <>
      <Title>Runs</Title>
      {workflow.status === "CREATED" && (
        <>
          <PanelWarning className="mb-6">
            This workflow requires its APIs to be connected before it can run.
          </PanelWarning>
        </>
      )}
      {workflow.status === "DISABLED" && (
        <PanelInfo className="mb-6">
          <Body className="flex grow items-center justify-between">
            This workflow is disabled. Runs cannot be triggered or tested while
            disabled. Runs in progress will continue until complete.
          </Body>
          <TertiaryLink to="settings" className="mr-1">
            Settings
          </TertiaryLink>
        </PanelInfo>
      )}
      <fetcher.Form
        method="get"
        className="pb-4 flex gap-2"
        onChange={submitForm}
        ref={formRef}
      >
        <StatusFilter statuses={filters.statuses} submitForm={submitForm} />
      </fetcher.Form>
      <Panel
        className={classNames(
          "p-0 overflow-hidden overflow-x-auto",
          total === 0 ? "rounded-b-lg" : "rounded-b-none"
        )}
      >
        <RunsTable
          runs={runs}
          total={total}
          hasFilters={hasFilters}
          isLoading={isLoading}
        />
      </Panel>
      <PaginationControls
        currentPage={page}
        totalPages={pageCount}
        pageSize={pageSize}
        totalResults={total}
      />
    </>
  );
}

function StatusFilter({
  statuses,
  submitForm,
}: {
  statuses: WorkflowRunStatus[];
  submitForm: () => void;
}) {
  const [selectedStatuses, setSelectedStatuses] =
    useState<WorkflowRunStatus[]>(statuses);

  useEffect(() => {
    if (statuses.join("") === selectedStatuses.join("")) return;
    submitForm();
  }, [submitForm, selectedStatuses, statuses]);

  return (
    <>
      {selectedStatuses.length > 0 && (
        <input
          type="hidden"
          name={"statuses"}
          value={selectedStatuses.join(",")}
          onChange={(val) => console.log(val)}
        />
      )}
      <Listbox value={selectedStatuses} onChange={setSelectedStatuses} multiple>
        <div className="relative mt-1 w-52">
          <StyledListBox.Button>
            {selectedStatuses.length === allStatuses.length
              ? "All statuses"
              : selectedStatuses.length === 0
              ? "None"
              : selectedStatuses
                  .map((status) => runStatusTitle(status))
                  .join(", ")}
          </StyledListBox.Button>
          <StyledListBox.Options>
            {allStatuses.map((status) => (
              <StyledListBox.Option key={status} value={status}>
                {({ selected, active }) => (
                  <>
                    <span
                      className={classNames(
                        selected ? "" : "",
                        "flex truncate font-semibold items-center gap-1"
                      )}
                    >
                      {runStatusIcon(status, "small")}
                      {runStatusLabel(status)}
                    </span>

                    {selected ? (
                      <span
                        className={classNames(
                          active ? "text-white" : "text-blue-500",
                          "absolute inset-y-0 right-0 flex items-center pr-4"
                        )}
                      >
                        <CheckIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    ) : null}
                  </>
                )}
              </StyledListBox.Option>
            ))}
          </StyledListBox.Options>
        </div>
      </Listbox>
    </>
  );
}
