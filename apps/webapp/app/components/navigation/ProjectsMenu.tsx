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
import { PlusIcon } from "@heroicons/react/24/solid";
import {
  newOrganizationPath,
  newProjectPath,
  projectPath,
} from "~/utils/pathBuilder";
import { useCurrentProject } from "~/hooks/useProject";

export function ProjectsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();
  const isNewOrgPage = useIsNewOrganizationPage();
  const currentProject = useCurrentProject();

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
          {currentProject?.name ?? "Select a project"}
        </PopoverArrowTrigger>
        <PopoverContent className="w-80 p-0">
          {organizations.map((organization) => (
            <div key={organization.id}>
              <PopoverSectionHeader title={organization.title} />

              <div className="flex flex-col gap-1">
                {organization.projects.map((project) => {
                  const isSelected = project.id === currentProject?.id;
                  return (
                    <LinkButton
                      key={project.id}
                      to={projectPath(organization, project)}
                      variant="menu-item"
                      LeadingIcon="folder"
                      fullWidth
                      textAlignLeft
                      TrailingIcon={isSelected ? "check" : undefined}
                      className={
                        isSelected
                          ? "bg-slate-750 group-hover:bg-slate-750"
                          : undefined
                      }
                    >
                      {project.name}
                    </LinkButton>
                  );
                })}
                <LinkButton
                  to={newProjectPath(organization)}
                  variant="menu-item"
                  LeadingIcon="plus"
                  fullWidth
                  textAlignLeft
                >
                  New Project
                </LinkButton>
              </div>
            </div>
          ))}
          <div className="border-t border-slate-700">
            <LinkButton
              to={newOrganizationPath()}
              variant="menu-item"
              LeadingIcon="plus"
              fullWidth
              textAlignLeft
            >
              New Organization
            </LinkButton>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
