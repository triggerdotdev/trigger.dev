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
import { PanelWarning } from "~/components/layout/PanelInfo";
import {
  PrimaryButton,
  SecondaryLink,
  TertiaryA,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { WorkflowList } from "~/components/workflows/workflowList";
import { ProjectOverviewPresenter } from "~/features/ee/projects/presenters/projectOverviewPresenter.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { useCurrentProject } from "../$projectP";
import { DeploymentListItem } from "../../../components/DeploymentListItem";
import { ManuallyDeployProject } from "../../../services/manuallyDeployProject.server";
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
  const { project, needsEnvVars } = useCurrentProject();
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
      {needsEnvVars && (
        <PanelWarning
          message="Deployments are disabled until you add the required environment variables."
          className="mb-6"
        >
          <TertiaryLink to="settings" className="mr-1">
            Set Environment Variables
          </TertiaryLink>
        </PanelWarning>
      )}
      <SubTitle>Repository</SubTitle>

      <Panel className="mb-6 px-4 py-5">
        <ul className="mb-6 grid grid-cols-3 gap-x-8">
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Name
            </Body>
            <TertiaryA
              href={project.url}
              target="_blank"
              className={classNames(deploySummaryValueStyles, "!text-base")}
            >
              {project.name}#{project.branch}
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </TertiaryA>
          </li>
          <li className={deploySummaryGridStyles}>
            <Body size="extra-small" className={deploySummaryLabelStyles}>
              Status
            </Body>
            <div className="flex items-start gap-2">
              <div>
                {project.status === "PENDING" ||
                project.status === "PREPARING" ||
                project.status === "BUILDING" ||
                project.status === "DEPLOYING" ? (
                  <Spinner className="h-6 w-6" />
                ) : (
                  <></>
                )}
                {project.status === "DEPLOYED" ? (
                  <CloudIcon className="h-6 w-6 text-blue-500" />
                ) : (
                  <></>
                )}
                {project.status === "DISABLED" ? (
                  <ExclamationTriangleIcon className="h-6 w-6 text-amber-500" />
                ) : (
                  <></>
                )}
                {project.status === "ERROR" ? (
                  <ExclamationTriangleIcon className="h-6 w-6 text-rose-500" />
                ) : (
                  <></>
                )}
              </div>
              <Body className={deploySummaryValueStyles}>
                {project.status.charAt(0).toUpperCase() +
                  project.status.slice(1).toLowerCase()}
              </Body>
            </div>
          </li>
        </ul>
        <div className={deploySummaryGridStyles}>
          <Body size="extra-small" className={deploySummaryLabelStyles}>
            Latest commit
          </Body>
          <Body className={deploySummaryValueStyles}>
            eb9adfe: "Initial commit" by James Ritchie
          </Body>
        </div>
      </Panel>
      <div className="relative mb-6 rounded-lg bg-slate-850">
        <SubTitle>Workflows</SubTitle>
        {workflows.length === 0 ? (
          <Body className="text-slate-500">
            No workflows have connected in this repo yet
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
