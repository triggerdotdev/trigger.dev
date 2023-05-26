import { BeakerIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import humanizeDuration from "humanize-duration";
import type { ReactNode } from "react";
import { dateDifference, formatDateTime } from "~/utils";
import { Spinner } from "../primitives/Spinner";
import { cn } from "~/utils/cn";
import { RunList } from "~/presenters/RunListPresenter.server";
import { RunStatusIcon, RunStatusLabel } from "./RunStatuses";
import { runPath } from "~/utils/pathBuilder";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

export function RunsTable({
  total,
  hasFilters,
  runs,
  isLoading = false,
}: {
  total: number;
  hasFilters: boolean;
  runs: RunList["runs"];
  isLoading?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  return (
    <table className="w-full divide-y divide-slate-850 overflow-hidden rounded-md border border-slate-900 bg-slate-950">
      <thead className=" rounded-t-md">
        <tr>
          <HeaderCell title="Started" />
          <HeaderCell title="ID" />
          <HeaderCell title="Status" />
          <HeaderCell title="Completed" />
          <HeaderCell title="Duration" alignment="right" />
          <HeaderCell title="Test" alignment="right" />
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
            const path = runPath(organization, project, job, run);
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
                    {RunStatusIcon(run.status, "small")}
                    {RunStatusLabel(run.status)}
                  </span>
                </Cell>
                <Cell to={path} alignment="left">
                  {run.completedAt
                    ? formatDateTime(run.completedAt, "long")
                    : "–"}
                </Cell>
                <Cell to={path}>
                  {run.startedAt && run.completedAt
                    ? humanizeDuration(
                        dateDifference(run.startedAt, run.completedAt)
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
          <tr className="absolute left-0 top-0 h-full w-full bg-slate-800/90">
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

function HeaderCell({
  title,
  alignment = "left",
}: {
  title: string;
  alignment?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-3 text-xs font-semibold uppercase text-slate-400",
        alignment === "left" ? "text-left" : "text-right"
      )}
    >
      {title}
    </th>
  );
}

const cell = "flex whitespace-nowrap text-sm text-slate-300";
const cellLeftAligned = cn(cell, "justify-start");
const cellRightAligned = cn(cell, "justify-end");

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
        className={cn(
          "w-full px-4 py-3",
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
      THERE ARE NO RUNS HERE, {":("}
    </div>
  );
}
