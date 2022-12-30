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
}: {
  icon: ReactNode;
  title: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  integration?: string;
}) {
  return (
    <div className="flex mb-4 pb-3 justify-between items-center border-b border-slate-700">
      <div className="flex gap-1 items-center">
        {icon}
        <Body size="small" className="uppercase text-slate-400 font-semibold">
          {title}
        </Body>
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
      </ul>
    </div>
  );
}
