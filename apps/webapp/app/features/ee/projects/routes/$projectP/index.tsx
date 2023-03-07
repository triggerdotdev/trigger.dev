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
import { useRevalidator } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { IntlDate } from "~/components/IntlDate";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { TertiaryA } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { WorkflowList } from "~/components/workflows/workflowList";
import { ProjectOverviewPresenter } from "~/features/ee/projects/presenters/projectOverviewPresenter.server";
import { useCurrentProject } from "../$projectP";

export async function loader({ params }: LoaderArgs) {
  const { projectP, organizationSlug } = z
    .object({ projectP: z.string(), organizationSlug: z.string() })
    .parse(params);

  const presenter = new ProjectOverviewPresenter();

  return typedjson(await presenter.data(organizationSlug, projectP));
}

export default function ProjectOverviewPage() {
  const project = useCurrentProject();
  const { workflows, organizationSlug, deployments } =
    useTypedLoaderData<typeof loader>();

  const events = useEventSource(`/resources/projects/${project.id}`, {
    event: "update",
  });
  const revalidator = useRevalidator();

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  let Icon = ExclamationTriangleIcon;

  switch (project.status) {
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
  }

  return (
    <>
      <Title>Overview</Title>
      <SubTitle>
        {project.name}#{project.branch}
      </SubTitle>
      <Panel>
        <PanelHeader
          icon={
            <div className="mr-1 h-6 w-6">
              <Icon />
            </div>
          }
          title={project.statusText ? project.statusText : "No status"}
          startedAt={null}
          finishedAt={null}
        />
      </Panel>
      <div className="mt-6 max-w-4xl">
        <div className="relative rounded-lg bg-slate-850">
          <SubTitle>Workflows</SubTitle>

          <WorkflowList
            className="relative z-50 !mb-0"
            workflows={workflows}
            currentOrganizationSlug={organizationSlug}
          />
        </div>
      </div>
      <div className="mt-6 max-w-4xl">
        <div className="relative rounded-lg bg-slate-850">
          <SubTitle>Latest deploys</SubTitle>

          <List className="relative z-50 !mb-0">
            {deployments.map((deployment) => (
              <DeploymentListItem
                key={deployment.id}
                deployment={deployment}
                repo={project.name}
                isCurrentDeployment={
                  deployment.id === project.currentDeployment?.id
                }
              />
            ))}
          </List>
        </div>
      </div>
    </>
  );
}

function DeploymentListItem({
  deployment,
  repo,
  isCurrentDeployment,
}: {
  deployment: ProjectDeployment;
  repo: string;
  isCurrentDeployment: boolean;
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
                  Commit #{deployment.commitHash.substring(0, 7)}{" "}
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                </TertiaryA>
              </div>
              <div className="text-sm font-medium text-slate-200">
                {deployment.commitMessage}
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
  );
}
