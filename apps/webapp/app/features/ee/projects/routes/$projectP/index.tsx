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
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import {
  PrimaryButton,
  SecondaryButton,
  SecondaryLink,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { WorkflowList } from "~/components/workflows/workflowList";
import { ProjectOverviewPresenter } from "~/features/ee/projects/presenters/projectOverviewPresenter.server";
import { redirectWithErrorMessage } from "~/models/message.server";
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

export async function action({ params, request }: ActionArgs) {
  const { projectP, organizationSlug } = z
    .object({ projectP: z.string(), organizationSlug: z.string() })
    .parse(params);

  const service = new ManuallyDeployProject();

  const deployment = await service.call(projectP);

  if (deployment) {
    return redirect(
      `/orgs/${organizationSlug}/projects/${projectP}/deploys/${deployment.id}`
    );
  }

  return redirectWithErrorMessage(
    `/orgs/${organizationSlug}/projects/${projectP}/deploys`,
    request,
    "Failed to deploy project"
  );
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
      <div className="flex items-start justify-between">
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
          <PrimaryButton type="submit">
            <CloudArrowUpIcon className="-ml-1 h-5 w-5" />
            Manual Deploy
          </PrimaryButton>
        </Form>
      </div>
      <SubTitle>
        {project.name}#{project.branch}
      </SubTitle>
      <Panel className="mb-6">
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
      <div className="relative mb-6 rounded-lg bg-slate-850">
        <SubTitle>Workflows</SubTitle>
        {workflows.length === 0 ? (
          <Body className="text-slate-500">No workflows added</Body>
        ) : (
          <WorkflowList
            workflows={workflows}
            currentOrganizationSlug={organizationSlug}
          />
        )}
      </div>
      <div className="relative rounded-lg bg-slate-850">
        <div className="mb-2 flex items-center justify-between">
          <SubTitle className="mb-0">Latest deploys</SubTitle>
          {deployments.length === 0 ? (
            <></>
          ) : (
            <SecondaryLink to="deploys">View all</SecondaryLink>
          )}
        </div>
        {deployments.length === 0 ? (
          <Body className="text-slate-500">No deploys yet</Body>
        ) : (
          <List>
            {deployments.map((deployment) => (
              <DeploymentListItem
                pathPrefix="deploys"
                key={deployment.id}
                deployment={deployment}
                repo={project.name}
                isCurrentDeployment={
                  deployment.id === project.currentDeployment?.id
                }
              />
            ))}
          </List>
        )}
      </div>
    </>
  );
}
