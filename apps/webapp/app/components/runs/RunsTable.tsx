import { BeakerIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import humanizeDuration from "humanize-duration";
import type { ReactNode } from "react";
import type { WorkflowRunListPresenter } from "~/models/workflowRunListPresenter.server";
import { dateDifference, formatDateTime } from "~/utils";
import { PanelWarning } from "../layout/PanelWarning";
import { Spinner } from "../primitives/Spinner";
import { runStatusIcon, runStatusLabel } from "./runStatus";

const headerCell = "px-4 py-5 text-left text-base font-semibold text-slate-300";
const headerCellRightAlign = classNames(headerCell, "text-right");

export function RunsTable({
  total,
  hasFilters,
  runs,
  basePath,
  isLoading = false,
}: {
  total: number;
  hasFilters: boolean;
  runs: Awaited<ReturnType<WorkflowRunListPresenter["data"]>>["runs"];
  basePath?: string;
  isLoading?: boolean;
}) {
  return (
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
      <tbody className="relative divide-y divide-slate-850">
        {total === 0 && !hasFilters ? (
          <BlankRow>
            <NoRuns title="No runs found for this Workflow" />
          </BlankRow>
        ) : runs.length === 0 ? (
          <BlankRow>
            <NoRuns title="No runs match your filters" />
          </BlankRow>
        ) : (
          runs.map((run) => {
            const path = basePath ? `${basePath}/${run.id}` : run.id;
            return (
              <tr key={run.id} className="group w-full">
                <Cell to={path} alignment="left">
                  {run.startedAt ? formatDateTime(run.startedAt, "long") : "–"}
                </Cell>
                <Cell to={path} alignment="left">
                  {run.id}
                </Cell>
                <Cell to={path} alignment="left">
                  <span className="flex items-center gap-1">
                    {runStatusIcon(run.status, "small")}
                    {runStatusLabel(run.status)}
                  </span>
                </Cell>
                <Cell to={path} alignment="left">
                  {run.finishedAt
                    ? formatDateTime(run.finishedAt, "long")
                    : "–"}
                </Cell>
                <Cell to={path}>
                  {run.startedAt && run.finishedAt
                    ? humanizeDuration(
                        dateDifference(run.startedAt, run.finishedAt)
                      )
                    : "–"}
                </Cell>
                <Cell to={path}>
                  {run.isTest && (
                    <BeakerIcon className="h-5 w-5 text-green-500" />
                  )}
                </Cell>
              </tr>
            );
          })
        )}
        {isLoading && (
          <tr className="absolute top-0 left-0 h-full w-full bg-slate-800/90">
            <td
              colSpan={6}
              className="flex h-full items-center justify-center gap-2 text-white"
            >
              <Spinner /> Loading…
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

const cell = "flex whitespace-nowrap text-sm text-slate-300";
const cellLeftAligned = classNames(cell, "justify-start");
const cellRightAligned = classNames(cell, "justify-end");

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
    <td className="cursor-pointer transition group-hover:bg-slate-850/50">
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

function BlankRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={6} className="py-6 text-center text-sm">
        {children}
      </td>
    </tr>
  );
}

export function NoRuns({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <PanelWarning message={title} className="max-w-max" />
    </div>
  );
}
