import { Listbox } from "@headlessui/react";
import { BeakerIcon, CheckIcon } from "@heroicons/react/24/outline";
import { InformationCircleIcon } from "@heroicons/react/24/solid";
import { Link, useFetcher, useSubmit } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import humanizeDuration from "humanize-duration";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Panel } from "~/components/layout/Panel";
import { PaginationControls } from "~/components/Pagination";
import { StyledListBox } from "~/components/primitives/ListBox";
import { Header1 } from "~/components/primitives/text/Headers";
import {
  runStatusIcon,
  runStatusLabel,
  runStatusTitle,
} from "~/components/runs/runStatus";
import type { WorkflowRunStatus } from "~/models/workflowRun.server";
import { WorkflowRunListPresenter } from "~/models/workflowRunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { dateDifference, formatDateTime } from "~/utils";

const headerCell = "px-4 py-5 text-left text-base font-semibold text-slate-300";
const headerCellRightAlign = classNames(headerCell, "text-right");
const cell = "flex whitespace-nowrap text-sm text-slate-300";
const cellLeftAligned = classNames(cell, "justify-start");
const cellRightAligned = classNames(cell, "justify-end");

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");
  invariant(workflowSlug, "workflowSlug is required");

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);

  try {
    const presenter = new WorkflowRunListPresenter();
    const result = await presenter.data({
      userId,
      organizationSlug,
      workflowSlug,
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
  const formRef = useRef<HTMLFormElement>(null);

  const submitForm = useCallback(() => {
    if (!formRef.current) return;
    submit(formRef.current, { replace: true });
  }, [submit]);

  return (
    <>
      <Header1 className="mb-6">Runs</Header1>
      <fetcher.Form
        method="get"
        className="pb-4 flex gap-2"
        onChange={submitForm}
        ref={formRef}
      >
        <StatusFilter statuses={filters.statuses} submitForm={submitForm} />
      </fetcher.Form>
      <Panel className="p-0 overflow-hidden overflow-x-auto">
        <table className="w-full divide-y divide-slate-850">
          <thead className="bg-slate-700/20">
            <tr>
              <th scope="col" className={headerCell}>
                Started
              </th>
              <th scope="col" className={headerCell}>
                ID
              </th>
              <th scope="col" className={headerCell}>
                Status
              </th>
              <th scope="col" className={headerCell}>
                Completed
              </th>
              <th scope="col" className={headerCellRightAlign}>
                Duration
              </th>
              <th scope="col" className={headerCellRightAlign}>
                Test
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-850">
            {total === 0 && !hasFilters ? (
              <BlankRow title="No runs found for this Workflow" />
            ) : runs.length === 0 ? (
              <BlankRow title="No runs match your filters" />
            ) : (
              runs.map((run) => (
                <tr key={run.id} className="group w-full">
                  <Cell to={run.id} alignment="left">
                    {run.startedAt
                      ? formatDateTime(run.startedAt, "long")
                      : "–"}
                  </Cell>
                  <Cell to={run.id} alignment="left">
                    {run.id}
                  </Cell>
                  <Cell to={run.id} alignment="left">
                    <span className="flex items-center gap-1">
                      {runStatusIcon(run.status, "small")}
                      {runStatusLabel(run.status)}
                    </span>
                  </Cell>
                  <Cell to={run.id} alignment="left">
                    {run.finishedAt
                      ? formatDateTime(run.finishedAt, "long")
                      : "–"}
                  </Cell>
                  <Cell to={run.id}>
                    {run.startedAt && run.finishedAt
                      ? humanizeDuration(
                          dateDifference(run.startedAt, run.finishedAt)
                        )
                      : "–"}
                  </Cell>
                  <Cell to={run.id}>
                    {run.isTest && (
                      <BeakerIcon className="h-5 w-5 text-green-500" />
                    )}
                  </Cell>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <PaginationControls
          currentPage={page}
          totalPages={pageCount}
          pageSize={pageSize}
          totalResults={total}
        />
      </Panel>
    </>
  );
}

function Cell({
  children,
  to,
  alignment = "right",
}: {
  children: React.ReactNode;
  to: string;
  alignment?: "left" | "right";
}) {
  return (
    <td className="group-hover:bg-slate-850/50 transition cursor-pointer">
      <Link
        to={to}
        className={classNames(
          "w-full py-3 px-4",
          alignment === "right" ? cellRightAligned : cellLeftAligned
        )}
      >
        {children}
      </Link>
    </td>
  );
}

function BlankRow({ title }: { title: string }) {
  return (
    <tr>
      <td colSpan={6} className="py-6 text-sm text-center">
        <div className="flex items-center justify-center">
          <div className="flex items-center justify-center p-3 pr-4 gap-1 bg-yellow-200 border border-yellow-400 rounded-md text-yellow-700">
            <InformationCircleIcon className="w-5 h-5" />
            <span className="text-gray">{title}</span>
          </div>
        </div>
      </td>
    </tr>
  );
}

const allStatuses: WorkflowRunStatus[] = [
  "PENDING",
  "RUNNING",
  "SUCCESS",
  "ERROR",
];

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
    setSelectedStatuses(statuses);
  }, [statuses]);

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
            {selectedStatuses.length === 4
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
                        selected ? "font-semibold" : "font-normal",
                        "flex truncate items-center gap-1"
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
