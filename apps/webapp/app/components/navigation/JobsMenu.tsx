import { useState } from "react";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { jobPath } from "~/utils/pathBuilder";
import { IconNames } from "../primitives/NamedIcon";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";

export function JobsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const currentJob = useJob();

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
