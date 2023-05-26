import { BeakerIcon } from "@heroicons/react/24/outline";
import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { ReactNode } from "react";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunList } from "~/presenters/RunListPresenter.server";
import { formatDateTime, formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import { runPath } from "~/utils/pathBuilder";
import {
  EnvironmentLabel,
  environmentTitle,
} from "../environments/EnvironmentLabel";
import { Spinner } from "../primitives/Spinner";
import { RunStatus } from "./RunStatuses";

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
          <HeaderCell title="Run" />
          <HeaderCell title="Env" />
          <HeaderCell title="Status" />
          <HeaderCell title="Started" />
          <HeaderCell title="Duration" />
          <HeaderCell title="Test" />
          <HeaderCell title="Version" />
          <th>
            <span className="sr-only">Go to page</span>
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
            const path = runPath(organization, project, job, run);
            return (
              <tr key={run.id} className="group w-full">
                <Cell to={path}>#{run.number}</Cell>
                <Cell to={path}>
                  <EnvironmentLabel environment={run.environment} />
                </Cell>
                <Cell to={path}>
                  <RunStatus status={run.status} />
                </Cell>
                <Cell to={path}>
                  {run.startedAt
                    ? formatDateTime(run.startedAt, "medium")
                    : "–"}
                </Cell>
                <Cell to={path}>
                  {formatDuration(run.startedAt, run.completedAt, {
                    style: "short",
                  })}
                </Cell>
                <Cell to={path}>
                  {run.isTest && (
                    <BeakerIcon className="h-5 w-5 text-green-500" />
                  )}
                </Cell>
                <Cell to={path}>{run.version}</Cell>
                <Cell to={path} alignment="right">
                  <ChevronRightIcon className="h-4 w-4 text-slate-700" />
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

function Cell({
  children,
  to,
  alignment = "left",
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
          "flex w-full whitespace-nowrap px-4 py-3 text-left text-xs text-slate-400",
          alignment === "left"
            ? "justify-start text-left"
            : "justify-end text-right"
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
