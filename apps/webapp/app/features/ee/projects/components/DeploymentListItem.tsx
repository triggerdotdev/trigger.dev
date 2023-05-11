import type { ProjectDeployment } from ".prisma/client";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { DateTime } from "~/components/primitives/DateTime";
import { Body } from "~/components/primitives/text/Body";
import {
  deploymentStatusDot,
  deploymentStatusIcon,
  deploymentStatusTitle,
} from "./deploymentStatus";

export function DeploymentListItem({
  deployment,
  repo,
  isCurrentDeployment,
  pathPrefix,
}: {
  deployment: ProjectDeployment;
  repo: string;
  isCurrentDeployment: boolean;
  pathPrefix: string;
}) {
  let timestamp = deployment.createdAt;

  if (deployment.stoppedAt) {
    timestamp = deployment.stoppedAt;
  } else if (deployment.buildFinishedAt) {
    timestamp = deployment.buildFinishedAt;
  } else if (deployment.buildStartedAt) {
    timestamp = deployment.buildStartedAt;
  }

  return (
    <li className="transition hover:bg-slate-850/40">
      <Link to={`${pathPrefix}/${deployment.id}`}>
        <div className="flex flex-col flex-wrap justify-between py-4 pl-4 pr-6">
          <div className="flex flex-1 items-center justify-between">
            <div className="relative flex items-center">
              <div className="absolute -left-7 flex h-6 w-6 items-center justify-center rounded-full bg-slate-800">
                {deploymentStatusDot(deployment.status)}
              </div>
              <div className="mr-4 flex h-12 w-12 items-center justify-center rounded-md bg-slate-850 p-2">
                {deploymentStatusIcon(deployment.status, "large")}
              </div>
              <div className="flex flex-col">
                <Body className="text-lg font-medium text-slate-100/80 transition hover:text-white">
                  {deployment.commitMessage} #
                  {deployment.commitHash.substring(0, 7)}
                </Body>
                <div className="flex items-center gap-2">
                  <Body size="small" className="text-slate-500">
                    {deployment.version}
                  </Body>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {deploymentStatusDot(deployment.status)}
                  <Body size="small" className="text-slate-300">
                    {deploymentStatusTitle(deployment.status)}
                  </Body>
                </div>
                <div className="text-xs font-medium text-slate-500">
                  <DateTime date={timestamp} timeZone="UTC" />
                </div>
              </div>
              <ChevronRightIcon className="h-4 w-4 text-slate-400" />
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}
