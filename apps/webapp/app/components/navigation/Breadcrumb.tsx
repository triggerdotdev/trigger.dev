import { useMatches } from "@remix-run/react";
import { Fragment } from "react";
import {
  useIntegrationClient,
  useOptionalIntegrationClient,
} from "~/hooks/useIntegrationClient";
import { useJob, useOptionalJob } from "~/hooks/useJob";
import {
  useOptionalOrganization,
  useOrganization,
} from "~/hooks/useOrganizations";
import { useOptionalProject, useProject } from "~/hooks/useProject";
import { useOptionalRun, useRun } from "~/hooks/useRun";
import {
  integrationClientConnectionsPath,
  integrationClientPath,
  integrationClientScopesPath,
  jobPath,
  jobTestPath,
  projectEnvironmentsPath,
  projectIntegrationsPath,
  projectPath,
  projectTriggersPath,
  runDashboardPath,
} from "~/utils/pathBuilder";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";
import { JobsMenu } from "./JobsMenu";
import { BreadcrumbLink } from "./NavBar";
import { ProjectsMenu } from "./ProjectsMenu";

export type Breadcrumb = {
  slug:
    | "projects"
    | "jobs"
    | "integrations"
    | "integration"
    | "integration-job"
    | "integration-connections"
    | "integration-scopes"
    | "triggers"
    | "environments"
    | "job"
    | "test"
    | "runs"
    | "run";
  link?: {
    to: string;
    title: string;
  };
};

function useBreadcrumbs(): Breadcrumb[] {
  const matches = useMatches();

  return matches
    .filter((match) => match.handle)
    .filter((match) => match.handle!.breadcrumb)
    .map((match) => match.handle!.breadcrumb as Breadcrumb);
}

export function Breadcrumb() {
  const breadcrumbs = useBreadcrumbs();
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const job = useOptionalJob();
  const run = useOptionalRun();
  const client = useOptionalIntegrationClient();

  return (
    <div className="hidden items-center md:flex">
      {breadcrumbs.map((breadcrumb, index) => (
        <Fragment key={breadcrumb.slug}>
          <BreadcrumbIcon />
          <BreadcrumbItem
            breadcrumb={breadcrumb}
            organization={organization}
            project={project}
            job={job}
            run={run}
            client={client}
          />
        </Fragment>
      ))}
    </div>
  );
}

function BreadcrumbItem({
  breadcrumb,
  organization,
  project,
  job,
  run,
  client,
}: {
  breadcrumb: Breadcrumb;
  organization?: ReturnType<typeof useOrganization>;
  project?: ReturnType<typeof useProject>;
  job?: ReturnType<typeof useJob>;
  run?: ReturnType<typeof useRun>;
  client?: ReturnType<typeof useIntegrationClient>;
}) {
  switch (breadcrumb.slug) {
    case "projects":
      return <ProjectsMenu key={breadcrumb.slug} />;
    case "jobs":
      if (!organization || !project) return null;
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectPath(organization, project)}
          title="Jobs"
        />
      );
    case "environments":
      if (!organization || !project) return null;
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectEnvironmentsPath(organization, project)}
          title="Environments"
        />
      );
    case "integrations":
      if (!organization || !project) return null;
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectIntegrationsPath(organization, project)}
          title="Integrations"
        />
      );
    case "integration":
      if (!organization || !project || !client) return null;
      return (
        <Fragment key={breadcrumb.slug}>
          <BreadcrumbLink
            to={projectIntegrationsPath(organization, project)}
            title="Integrations"
          />
          <BreadcrumbIcon />
          <BreadcrumbLink
            to={integrationClientPath(organization, project, client)}
            title={client.title}
          />
        </Fragment>
      );
    case "integration-job":
      if (!organization || !project || !client) return null;
      return (
        <BreadcrumbLink
          to={integrationClientPath(organization, project, client)}
          title={"Jobs"}
        />
      );
    case "integration-connections":
      if (!organization || !project || !client) return null;
      return (
        <BreadcrumbLink
          to={integrationClientConnectionsPath(organization, project, client)}
          title={"Connections"}
        />
      );
    case "integration-scopes":
      if (!organization || !project || !client) return null;
      return (
        <BreadcrumbLink
          to={integrationClientScopesPath(organization, project, client)}
          title={"Scopes"}
        />
      );
    case "triggers":
      if (!organization || !project) return null;
      return (
        <BreadcrumbLink
          to={projectTriggersPath(organization, project)}
          title={"Triggers"}
        />
      );
    case "job":
      if (!organization || !project || !job) return null;
      return (
        <Fragment key={breadcrumb.slug}>
          <BreadcrumbLink
            to={projectPath(organization, project)}
            title="Jobs"
          />
          <BreadcrumbIcon />
          <JobsMenu key={breadcrumb.slug} />
        </Fragment>
      );
    case "test":
      if (!organization || !project || !job) return null;
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={jobTestPath(organization, project, job)}
          title="Test"
        />
      );
    case "runs":
      if (!organization || !project || !job) return null;
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={jobPath(organization, project, job)}
          title="Runs"
        />
      );
    case "run":
      if (!organization || !project || !job || !run) return null;
      return (
        <Fragment key={breadcrumb.slug}>
          <BreadcrumbLink
            to={jobPath(organization, project, job)}
            title="Runs"
          />
          <BreadcrumbIcon />
          <BreadcrumbLink
            to={runDashboardPath(organization, project, job, run)}
            title={`Run #${run.number}`}
          />
        </Fragment>
      );
  }

  return <span className="text-red-500">{breadcrumb.slug}</span>;
}
