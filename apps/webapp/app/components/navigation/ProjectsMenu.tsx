import { RouteMatch } from "@remix-run/react";
import { Fragment, useState } from "react";
import simplur from "simplur";
import { Badge } from "~/components/primitives/Badge";
import {
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
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

export function ProjectsMenu({ matches }: { matches: RouteMatch[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const organizations = useOrganizations(matches);
  const isNewOrgPage = useIsNewOrganizationPage(matches);
  const currentProject = useOptionalProject(matches);

  if (isNewOrgPage) {
    return null;
  }

  return (
    <>
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>
          {currentProject?.name ?? "Select a project"}
        </PopoverArrowTrigger>
        <PopoverContent
          className="min-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
          collisionPadding={20}
        >
          {organizations.map((organization) => (
            <Fragment key={organization.id}>
              <PopoverSectionHeader title={organization.title} />
              <div className="flex flex-col gap-1 p-1 ">
                {organization.projects.map((project) => {
                  const isSelected = project.id === currentProject?.id;
                  return (
                    <PopoverMenuItem
                      key={project.id}
                      to={projectPath(organization, project)}
                      title={
                        <div className="flex w-[calc(100%-44px)] items-center justify-between pl-1 text-bright">
                          <span className="grow text-left">{project.name}</span>
                          <Badge className="mr-0.5">{simplur`${project._count.jobs} job[|s]`}</Badge>
                        </div>
                      }
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
          <div className="border-t border-slate-700 p-1">
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
