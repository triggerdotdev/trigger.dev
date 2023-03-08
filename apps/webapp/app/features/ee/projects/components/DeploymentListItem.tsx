import type { ProjectDeployment } from ".prisma/client";
import {
  ArrowTopRightOnSquareIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  StopCircleIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { IntlDate } from "~/components/IntlDate";
import { TertiaryA } from "~/components/primitives/Buttons";

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
  let Icon = ExclamationTriangleIcon;

  switch (deployment.status) {
    case "PENDING": {
      Icon = ClockIcon;
      break;
    }
    case "BUILDING": {
      Icon = CubeTransparentIcon;
      break;
    }
    case "DEPLOYING": {
      Icon = CloudArrowUpIcon;
      break;
    }
    case "DEPLOYED": {
      Icon = CloudIcon;
      break;
    }
    case "ERROR": {
      Icon = ExclamationTriangleIcon;
      break;
    }
    case "CANCELLED": {
      Icon = NoSymbolIcon;
      break;
    }
    case "STOPPING":
    case "STOPPED": {
      Icon = StopCircleIcon;
      break;
    }
  }

  let timestamp = deployment.createdAt;

  if (deployment.stoppedAt) {
    timestamp = deployment.stoppedAt;
  } else if (deployment.buildFinishedAt) {
    timestamp = deployment.buildFinishedAt;
  } else if (deployment.buildStartedAt) {
    timestamp = deployment.buildStartedAt;
  }

  return (
    <Link to={`${pathPrefix}/${deployment.id}`}>
      <li className={isCurrentDeployment ? "border-2 border-green-300" : ""}>
        <div className="flex flex-col flex-wrap justify-between py-4 pl-4 pr-4 lg:flex-row lg:flex-nowrap lg:items-center">
          <div className="flex flex-1 items-center justify-between">
            <div className="relative flex items-center">
              <div className="mr-4 h-20 w-20 flex-shrink-0 self-start rounded-md bg-slate-850 p-3">
                <Icon className="h-12 w-12 text-slate-500" />
              </div>
              <div className="flex flex-col">
                <div className="text-sm font-medium text-slate-200">
                  <TertiaryA
                    href={`https://github.com/${repo}/commit/${deployment.commitHash}`}
                    target="_blank"
                  >
                    {deployment.commitMessage} #
                    {deployment.commitHash.substring(0, 7)}{" "}
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  </TertiaryA>
                </div>
                <div className="text-sm font-medium text-slate-200">
                  {deployment.version}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end">
              <div className="text-sm font-medium text-slate-200">
                {deployment.status.toLocaleLowerCase()}
              </div>
              <div className="text-sm font-medium text-slate-200">
                <IntlDate date={timestamp} timeZone="UTC" />
              </div>
            </div>
          </div>
        </div>
      </li>
    </Link>
  );
}
