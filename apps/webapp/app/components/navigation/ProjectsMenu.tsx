import { Link } from "@remix-run/react";
import { useState } from "react";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverSectionHeader,
} from "../primitives/Popover";

export function ProjectsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined) {
    return null;
  }

  return (
    <>
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>
          {currentOrganization?.title ?? "Select an organization"}
        </PopoverArrowTrigger>
        <PopoverContent className="w-80 p-0">
          {organizations.map((organization) => (
            <div key={organization.id}>
              <PopoverSectionHeader title={organization.title} />

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
