import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverCustomTrigger } from "../primitives/Popover";
import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";

export function SideMenuHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  const [isHeaderMenuOpen, setHeaderMenuOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    setHeaderMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <div className="group flex items-center justify-between pl-1.5">
      <h2 className="text-xs">{title}</h2>
      {children !== undefined ? (
        <Popover onOpenChange={(open) => setHeaderMenuOpen(open)} open={isHeaderMenuOpen}>
          <PopoverCustomTrigger className="p-1">
            <EllipsisHorizontalIcon className="h-4 w-4 text-charcoal-500 transition group-hover:text-text-bright" />
          </PopoverCustomTrigger>
          <PopoverContent
            className="min-w-max overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
            align="start"
          >
            <div className="flex flex-col gap-1 p-1">{children}</div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
