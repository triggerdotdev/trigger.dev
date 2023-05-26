import { Fragment, useState } from "react";
import {
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  newOrganizationPath,
  newProjectPath,
  projectPath,
} from "~/utils/pathBuilder";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";

export function ProjectsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organizations = useOrganizations();
  const isNewOrgPage = useIsNewOrganizationPage();
  const currentProject = useProject();

  if (isNewOrgPage) {
    return null;
  }

  return (
    <>
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>
          {currentProject?.name ?? "Select a project"}
        </PopoverArrowTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          {organizations.map((organization) => (
            <Fragment key={organization.id}>
              <PopoverSectionHeader title={organization.title} />
              <div className="flex flex-col gap-1 p-1">
                {organization.projects.map((project) => {
                  const isSelected = project.id === currentProject?.id;
                  return (
                    <PopoverMenuItem
                      key={project.id}
                      to={projectPath(organization, project)}
                      title={project.name}
                      isSelected={isSelected}
                      icon="folder"
                    />
                  );
                })}
                <PopoverMenuItem
                  to={newProjectPath(organization)}
                  title="New Project"
                  isSelected={false}
                  icon="plus"
                />
              </div>
            </Fragment>
          ))}
          <div className="border-t border-slate-800 p-1">
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New Organization"
              isSelected={false}
              icon="plus"
            />
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
