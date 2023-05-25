import { Fragment, useState } from "react";
import {
  useCurrentOrganization,
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import {
  jobPath,
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
import invariant from "tiny-invariant";
import { IconNames } from "../primitives/NamedIcon";
import { useCurrentJob } from "~/hooks/useJob";

export function JobsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organization = useCurrentOrganization();
  const project = useCurrentProject();
  const currentJob = useCurrentJob();
  invariant(organization);
  invariant(project);

  return (
    <>
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>
          {currentJob?.title ?? "Select a job"}
        </PopoverArrowTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <PopoverSectionHeader title="Jobs" />
          <div className="flex flex-col gap-1 p-1">
            {project.jobs.map((job) => {
              const isSelected = job.id === currentJob?.id;
              return (
                <PopoverMenuItem
                  key={job.id}
                  to={jobPath(organization, project, job)}
                  title={job.title}
                  isSelected={isSelected}
                  icon={job.event.icon as IconNames}
                />
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
