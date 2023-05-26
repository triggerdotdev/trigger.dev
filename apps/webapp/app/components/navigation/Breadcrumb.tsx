import { useMatches } from "@remix-run/react";
import { Fragment } from "react";
import {
  useOptionalOrganization,
  useOrganization,
} from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  projectEnvironmentsPath,
  projectIntegrationsPath,
  projectPath,
} from "~/utils/pathBuilder";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";
import { JobsMenu } from "./JobsMenu";
import { BreadcrumbLink } from "./NavBar";
import { ProjectsMenu } from "./ProjectsMenu";

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
  const organization = useOptionalOrganization();
  const project = useProject();

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
  project?: ReturnType<typeof useProject>;
}) {
  switch (breadcrumb.slug) {
    case "projects":
      return <ProjectsMenu key={breadcrumb.slug} />;
    case "jobs":
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectPath(organization!, project!)}
          title="Jobs"
        />
      );
    case "environments":
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectEnvironmentsPath(organization!, project!)}
          title="Environments"
        />
      );
    case "integrations":
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectIntegrationsPath(organization!, project!)}
          title="Integrations"
        />
      );
    case "job":
      return (
        <Fragment key={breadcrumb.slug}>
          <BreadcrumbLink
            to={projectPath(organization!, project!)}
            title="Jobs"
          />
          <BreadcrumbIcon />
          <JobsMenu key={breadcrumb.slug} />
        </Fragment>
      );
    case "runs":
      return (
        <BreadcrumbLink
          key={breadcrumb.slug}
          to={projectPath(organization!, project!)}
          title="Runs"
        />
      );
  }

  return <span className="text-red-500">{breadcrumb.slug}</span>;
}
