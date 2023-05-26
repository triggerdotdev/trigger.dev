import { useMatches } from "@remix-run/react";
import { Fragment } from "react";
import invariant from "tiny-invariant";
import { useOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import {
  projectEnvironmentsPath,
  projectIntegrationsPath,
  projectPath,
} from "~/utils/pathBuilder";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";
import { BreadcrumbLink } from "./NavBar";
import { ProjectsMenu } from "./ProjectsMenu";
import { JobsMenu } from "./JobsMenu";

export type Breadcrumb = {
  slug: "projects" | "jobs" | "integrations" | "environments" | "job" | "runs";
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
  const organization = useOrganization();
  const project = useCurrentProject();

  return (
    <div className="hidden items-center md:flex">
      {breadcrumbs.map((breadcrumb, index) => (
        <Fragment key={breadcrumb.slug}>
          <BreadcrumbIcon />
          <BreadcrumbItem
            breadcrumb={breadcrumb}
            organization={organization}
            project={project}
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
}: {
  breadcrumb: Breadcrumb;
  organization?: ReturnType<typeof useOrganization>;
  project?: ReturnType<typeof useCurrentProject>;
}) {
  switch (breadcrumb.slug) {
    case "projects":
      return <ProjectsMenu key={breadcrumb.slug} />;
    case "jobs":
      invariant(organization, "Organization must be defined");
      invariant(project, "Project must be defined");
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectPath(organization, project)}
          title="Jobs"
        />
      );
    case "environments":
      invariant(organization, "Organization must be defined");
      invariant(project, "Project must be defined");
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectEnvironmentsPath(organization, project)}
          title="Environments"
        />
      );
    case "integrations":
      invariant(organization, "Organization must be defined");
      invariant(project, "Project must be defined");
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectIntegrationsPath(organization, project)}
          title="Integrations"
        />
      );
    case "job":
      invariant(organization, "Organization must be defined");
      invariant(project, "Project must be defined");
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
    case "runs":
      invariant(organization, "Organization must be defined");
      invariant(project, "Project must be defined");
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectPath(organization, project)}
          title="Runs"
        />
      );
  }

  return <span className="text-red-500">{breadcrumb.slug}</span>;
}
