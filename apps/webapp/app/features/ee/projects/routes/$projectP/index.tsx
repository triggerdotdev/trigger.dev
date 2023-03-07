import {
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { Form, useRevalidator } from "@remix-run/react";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { WorkflowList } from "~/components/workflows/workflowList";
import { ProjectOverviewPresenter } from "~/features/ee/projects/presenters/projectOverviewPresenter.server";
import { useCurrentProject } from "../$projectP";
import { DeploymentListItem } from "../../components/DeploymentListItem";
import { ManuallyDeployProject } from "../../services/manuallyDeployProject.server";

export async function loader({ params }: LoaderArgs) {
  const { projectP, organizationSlug } = z
    .object({ projectP: z.string(), organizationSlug: z.string() })
    .parse(params);

  const presenter = new ProjectOverviewPresenter();

  return typedjson(await presenter.data(organizationSlug, projectP));
}

export async function action({ params }: ActionArgs) {
  const { projectP } = z.object({ projectP: z.string() }).parse(params);

  const service = new ManuallyDeployProject();

  const deployment = await service.call(projectP);

  return typedjson({ deployment });
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
      <div className="flex items-baseline">
        <Title>Overview</Title>
        <Form
          reloadDocument
          method="post"
          onSubmit={(e) =>
            !confirm(
              "Are you sure you want to manually deploy this project?"
            ) && e.preventDefault()
          }
        >
          <PrimaryButton>Manual Deploy</PrimaryButton>
        </Form>
      </div>
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
