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
              <PopoverMenuItem to="#" title="My Blog" icon="folder" />
              <PopoverMenuItem to="#" title="New Project" isSelected={false} icon="plus" />
            </div>
          </Fragment>
          <div className="border-t border-charcoal-800 p-1">
            <PopoverMenuItem to="#" title="New Organization" isSelected={false} icon="plus" />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
