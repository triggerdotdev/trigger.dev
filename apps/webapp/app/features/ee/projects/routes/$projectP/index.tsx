import {
  ArrowTopRightOnSquareIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { Form, useRevalidator } from "@remix-run/react";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import { useEffect } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import {
  PrimaryButton,
  SecondaryLink,
  TertiaryA,
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
import {
  deploySummaryGridStyles,
  deploySummaryLabelStyles,
  deploySummaryValueStyles,
} from "./deploys/$deployId";

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
      <SubTitle>Repository</SubTitle>
      <Panel className="mb-6 !p-4">
        <ul className="mb-6 grid grid-cols-[repeat(4,_fit-content(800px))] gap-x-6">
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Name
            </Body>
            <Body className={deploySummaryValueStyles}>
              {project.name}#{project.branch}
            </Body>
          </li>
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Environment
            </Body>
            <Body className={deploySummaryValueStyles}>Live</Body>
          </li>
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Status
            </Body>
            <div className="flex items-start gap-2">
              <div className="h-5 w-5 text-slate-400">
                <Icon />
              </div>
              <Body className={deploySummaryValueStyles}>
                {project.statusText ? project.statusText : "No status"}
              </Body>
            </div>
          </li>
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              URL
            </Body>
            <TertiaryA
              href={project.url}
              target="_blank"
              className={classNames(deploySummaryValueStyles, "!text-base")}
            >
              {project.url}
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </TertiaryA>
          </li>
        </ul>
        <ul className="grid grid-cols-[repeat(4,_fit-content(800px))] gap-x-6">
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Branch
            </Body>
            <Body className={deploySummaryValueStyles}>{project.branch}</Body>
          </li>
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Latest commit
            </Body>
            <Body className={deploySummaryValueStyles}>
              {/* {deployment.commitHash.slice(0, 12)}
              <span>
                "{deployment.commitMessage}" by {deployment.committer}
              </span> */}
            </Body>
          </li>
        </ul>
      </Panel>
      <div className="relative mb-6 rounded-lg bg-slate-850">
        <SubTitle>Workflows</SubTitle>
        {workflows.length === 0 ? (
          <Body className="text-slate-500">
            No workflows have been added to this repo yet.
          </Body>
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
