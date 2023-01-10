import { ArrowRightIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { dateDifference, formatDateTime } from "~/utils";
import { Body } from "../primitives/text/Body";

const workflowNodeFlexClasses = "flex gap-1 items-baseline";
const workflowNodeUppercaseClasses = "uppercase text-slate-400";

export function PanelHeader({
  icon,
  title,
  startedAt,
  finishedAt,
  integration,
  runId,
  name,
}: {
  icon: ReactNode;
  title: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  integration?: string;
  runId?: string;
  name?: string;
}) {
  return (
    <div className="flex mb-4 pb-3 justify-between items-center border-b border-slate-700">
      <div className="flex gap-1 items-center">
        {icon}
        <Body size="small" className="uppercase text-slate-400 font-semibold">
          {title}
        </Body>
        {name && (
          <div className="flex gap-3 items-center ml-2">
            <span className="block h-5 border-l border-slate-700"></span>
            <Body size="small" className="text-slate-400">
              {name}
            </Body>
          </div>
        )}
      </div>
      <ul className="flex justify-end items-center gap-4">
        <div className={workflowNodeFlexClasses}>
          {startedAt && (
            <Body size="small">{formatDateTime(startedAt, "long")}</Body>
          )}
          {startedAt &&
            finishedAt &&
            dateDifference(startedAt, finishedAt) > 1000 && (
              <>
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  <ArrowRightIcon className="h-3 w-3" />
                </Body>
                <Body size="small">{formatDateTime(finishedAt, "long")}</Body>
              </>
            )}
        </div>

        {integration && (
          <li className="flex gap-2 items-center">
            <Body size="small">{integration}</Body>
          </li>
        )}

        {runId && (
          <li className="flex gap-2 items-center">
            <Body size="small">{runId}</Body>
          </li>
        )}
      </ul>
    </div>
  );
}
