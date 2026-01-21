import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Popover, PopoverContent, PopoverCustomTrigger } from "../primitives/Popover";
import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";

export function SideMenuHeader({
  title,
  children,
  isCollapsed = false,
  collapsedTitle,
}: {
  title: string;
  children?: React.ReactNode;
  isCollapsed?: boolean;
  /** When provided, this text stays visible when collapsed and the rest fades out */
  collapsedTitle?: string;
}) {
  const [isHeaderMenuOpen, setHeaderMenuOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    setHeaderMenuOpen(false);
  }, [navigation.location?.pathname]);

  // If collapsedTitle is provided and title starts with it, split the title
  const hasCollapsedTitle = collapsedTitle && title.startsWith(collapsedTitle);
  const visiblePart = hasCollapsedTitle ? collapsedTitle : title;
  const fadingPart = hasCollapsedTitle ? title.slice(collapsedTitle.length) : "";

  return (
    <motion.div
      className="group flex h-4 items-center justify-between overflow-hidden pl-1.5"
      initial={false}
      animate={{
        opacity: hasCollapsedTitle ? 1 : isCollapsed ? 0 : 1,
      }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      <h2 className="text-xs whitespace-nowrap">
        {visiblePart}
        {fadingPart && (
          <motion.span
            initial={false}
            animate={{
              opacity: isCollapsed ? 0 : 1,
            }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {fadingPart}
          </motion.span>
        )}
      </h2>
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
    </motion.div>
  );
}
