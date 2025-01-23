import { FolderIcon, PlusIcon } from "@heroicons/react/20/solid";
import { Fragment, useState } from "react";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "~/components/primitives/Popover";

export default function Story() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="p-20">
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>My Blog</PopoverArrowTrigger>
        <PopoverContent
          className="min-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          align="start"
        >
          <Fragment>
            <PopoverSectionHeader title="Acme Ltd." />

            <div className="flex flex-col gap-1 p-1">
              <PopoverMenuItem to="#" title="My Blog" icon={FolderIcon} />
              <PopoverMenuItem to="#" title="New Project" isSelected={false} icon={PlusIcon} />
            </div>
          </Fragment>
          <div className="border-t border-charcoal-800 p-1">
            <PopoverMenuItem to="#" title="New Organization" isSelected={false} icon={PlusIcon} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
