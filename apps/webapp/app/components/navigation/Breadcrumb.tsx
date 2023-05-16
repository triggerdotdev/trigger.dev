import { useMatches } from "@remix-run/react";
import { ProjectsMenu } from "./ProjectsMenu";
import { BreadcrumbLink } from "./NavBar";
import { projectEnvironmentsPath, projectPath } from "~/utils/pathBuilder";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";

export type Breadcrumb = {
  slug: "projects" | "jobs" | "integrations" | "environments";
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
  const organization = useCurrentOrganization();
  const project = useCurrentProject();

  return (
    <div className="hidden items-center md:flex">
      {breadcrumbs.map((breadcrumb, index) => {
        switch (breadcrumb.slug) {
          case "projects":
            return <ProjectsMenu key={breadcrumb.slug} />;
          case "jobs":
            return (
              organization &&
              project && (
                <BreadcrumbLink
                  key={breadcrumb.slug}
                  to={projectPath(organization, project)}
                  title="Jobs"
                />
              )
            );
          case "environments":
            return (
              organization &&
              project && (
                <BreadcrumbLink
                  key={breadcrumb.slug}
                  to={projectEnvironmentsPath(organization, project)}
                  title="Environments"
                />
              )
            );
          default:
            return <span className="text-red-500">{breadcrumb.slug}</span>;
        }
      })}
    </div>
  );
}
