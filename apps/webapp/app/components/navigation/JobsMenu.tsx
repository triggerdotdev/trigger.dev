import { useState } from "react";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { jobPath } from "~/utils/pathBuilder";
import { IconNames, NamedIcon } from "../primitives/NamedIcon";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { LabelValueStack } from "../primitives/LabelValueStack";
import { LinkButton } from "../primitives/Buttons";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";

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
        <PopoverContent
          className="w-80 overflow-y-auto p-0"
          align="start"
          collisionPadding={20}
        >
          <PopoverSectionHeader title="Jobs" />
          <div className="flex flex-col gap-1 p-1">
            {project.jobs.map((job) => {
              const isSelected = job.id === currentJob?.id;
              return (
                <Link
                  key={job.id}
                  to={jobPath(organization, project, job)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-2",
                    isSelected && "bg-slate-750 group-hover:bg-slate-750"
                  )}
                >
                  <NamedIcon name={job.event.icon} className="h-6 w-6" />
                  <LabelValueStack
                    label={job.title}
                    value={job.slug}
                    variant="primary"
                    className="w-full"
                  />
                  {isSelected && (
                    <NamedIcon name="check" className="mr-1 h-6 w-6" />
                  )}
                </Link>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
