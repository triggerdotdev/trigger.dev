import { Link, RouteMatch } from "@remix-run/react";
import { useState } from "react";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useJobs } from "~/hooks/useJobs";
import { cn } from "~/utils/cn";
import { jobPath } from "~/utils/pathBuilder";
import { LabelValueStack } from "../primitives/LabelValueStack";
import { NamedIcon } from "../primitives/NamedIcon";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverSectionHeader,
} from "../primitives/Popover";

export function JobsMenu({ matches }: { matches: RouteMatch[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const organization = useOrganization(matches);
  const project = useProject(matches);
  const projectJobs = useJobs(matches);
  const currentJob = useJob(matches);

  return (
    <>
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>
          {currentJob?.title ?? "Select a job"}
        </PopoverArrowTrigger>
        <PopoverContent
          className="min-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
          collisionPadding={20}
        >
          <PopoverSectionHeader title="Jobs" />
          <div className="flex flex-col gap-1 p-1">
            {projectJobs.map((job) => {
              const isSelected = job.id === currentJob?.id;
              return (
                <Link
                  key={job.id}
                  to={jobPath(organization, project, job)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-2 transition hover:bg-slate-800",
                    isSelected && "bg-slate-750 group-hover:bg-slate-750"
                  )}
                >
                  <NamedIcon name={job.event.icon} className="h-8 w-8" />
                  <LabelValueStack
                    label={job.title}
                    value={job.slug}
                    variant="primary"
                    className="w-full"
                  />
                  {isSelected && <NamedIcon name="check" className="mr-1 h-6 w-6" />}
                </Link>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
