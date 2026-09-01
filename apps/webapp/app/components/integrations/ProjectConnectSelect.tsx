import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { ChevronExtraSmallDown } from "~/assets/icons/ChevronExtraSmallDown";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { FolderClosedIcon } from "~/assets/icons/FolderClosedIcon";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";

type ConnectableProject = { id: string; slug: string; name: string };

const MENU_LABEL = "text-[0.90625rem] font-medium tracking-[-0.01em]";

export function ProjectConnectSelect({
  projects,
  configurePathFor,
}: {
  projects: ConnectableProject[];
  configurePathFor: (project: ConnectableProject) => string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sync menu state after navigation.
    setIsOpen(false);
  }, [navigation.location?.pathname]);

  if (projects.length === 0) {
    return null;
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger className="group mt-2 flex h-8 w-fit cursor-pointer items-center gap-2 rounded border border-grid-bright pl-2.5 pr-2 hover:bg-background-hover focus-custom">
        <span className={`${MENU_LABEL} text-text-bright`}>Select project to configure</span>
        <DropdownIcon className="size-4 min-w-4 text-text-dimmed group-hover:text-text-bright" />
      </PopoverTrigger>
      <PopoverContent
        className="min-w-56 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
        align="center"
        sideOffset={4}
      >
        <div className="flex flex-col gap-1 p-1">
          {projects.map((project) => (
            <PopoverMenuItem
              key={project.id}
              to={configurePathFor(project)}
              title={
                <span className="flex w-full items-center justify-between gap-2 text-text-bright">
                  <span className="min-w-0 grow truncate text-left">{project.name}</span>
                  <ChevronExtraSmallDown className="size-3.5 shrink-0 -rotate-90 text-text-dimmed opacity-0 transition-opacity group-hover/button:opacity-100" />
                </span>
              }
              icon={FolderClosedIcon}
              leadingIconClassName="h-5 w-5 text-indigo-500"
              className={MENU_LABEL}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
