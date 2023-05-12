import { Link } from "@remix-run/react";
import { useState } from "react";
import {
  useCurrentOrganization,
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { LinkButton } from "../primitives/Buttons";
import { FolderIcon, PlusIcon } from "@heroicons/react/24/solid";
import {
  newOrganizationPath,
  newProjectPath,
  projectPath,
} from "~/utils/pathBuilder";

//todo useCurrentProject and have a ticked state on a current one (if there is a current one)
export function ProjectsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();
  const isNewOrgPage = useIsNewOrganizationPage();

  if (
    organizations === undefined ||
    isNewOrgPage ||
    currentOrganization === undefined
  ) {
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

              <div className="flex flex-col gap-1">
                {organization.projects.map((project) => (
                  //todo change to use "folder" named icon and the new variant
                  <LinkButton
                    key={project.id}
                    to={projectPath(organization, project)}
                    variant="secondary/medium"
                    LeadingIcon={FolderIcon}
                  >
                    {project.name}
                  </LinkButton>
                ))}
                <LinkButton
                  to={newProjectPath(organization)}
                  variant="secondary/medium"
                  LeadingIcon={PlusIcon}
                >
                  New Project
                </LinkButton>
              </div>
            </div>
          ))}
          <div className="border-t border-slate-700">
            <LinkButton
              to={newOrganizationPath()}
              variant="secondary/medium"
              LeadingIcon={PlusIcon}
            >
              New Organization
            </LinkButton>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
