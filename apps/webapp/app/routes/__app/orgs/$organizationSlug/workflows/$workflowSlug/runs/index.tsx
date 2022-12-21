import {
  CheckIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import humanizeDuration from "humanize-duration";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Panel } from "~/components/layout/Panel";
import { Spinner } from "~/components/primitives/Spinner";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { runStatusIcon, runStatusTitle } from "~/components/runs/runStatus";
import { getWorkflowRuns } from "~/models/workflowRun.server";
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

  try {
    const runs = await getWorkflowRuns({
      userId,
      organizationSlug,
      workflowSlug,
    });
    return typedjson({ runs });
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 404 });
  }
};

export default function Page() {
  const { runs } = useTypedLoaderData<typeof loader>();

  return (
    <>
      <Header1 className="mb-6">Runs</Header1>
      <Header2 size="small" className="mb-2 text-slate-400">
        20 runs of 530
      </Header2>
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
            {runs.length > 0 ? (
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
                      {runStatusTitle(run.status)}
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
                    <CheckIcon className="h-5 w-5 text-green-500" />
                  </Cell>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="py-6 text-sm text-center">
                  <div className="flex items-center justify-center">
                    <div className="flex items-center justify-center p-3 pr-4 gap-1 bg-yellow-200 border border-yellow-400 rounded-md text-yellow-700">
                      <InformationCircleIcon className="w-5 h-5" />
                      <span className="text-gray">
                        No runs found for this Workflow
                      </span>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
