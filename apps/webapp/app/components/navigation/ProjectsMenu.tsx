import {
  useCurrentOrganization,
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { Link } from "@remix-run/react";

export function ProjectsMenu() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined) {
    return null;
  }

  return (
    <>
      <Popover>
        <PopoverTrigger className="px-2 text-white">
          {currentOrganization?.title ?? "Select an organization"}
        </PopoverTrigger>
        <PopoverContent className="w-80">
          {organizations.map((organization) => (
            <div key={organization.id}>
              <div>{organization.title}</div>
              <div>
                {organization.projects.map((project) => (
                  <Link
                    key={project.id}
                    to={`/orgs/${organization.slug}/project/${project.id}`}
                  >
                    {project.name}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </>
  );
}
