import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Popover, PopoverContent, PopoverEllipseTrigger } from "../primitives/Popover";

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
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setHeaderMenuOpen(false);
  }, [navigation.location?.pathname]);

  // If collapsedTitle is provided and title starts with it, split the title
  const hasCollapsedTitle = collapsedTitle && title.startsWith(collapsedTitle);
  const visiblePart = hasCollapsedTitle ? collapsedTitle : title;
  const fadingPart = hasCollapsedTitle ? title.slice(collapsedTitle.length) : "";

  return (
    <motion.div
      className="group/side-header flex h-4 items-center justify-between overflow-hidden pl-1.5"
      initial={false}
      animate={{
        opacity: hasCollapsedTitle ? 1 : isCollapsed ? 0 : 1,
      }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      <h2 className="text-xs whitespace-nowrap">
        {visiblePart}
        {fadingPart && (
          // --sm-label-opacity morphs "Project" → "Proj" as the menu narrows (unset elsewhere → 1).
          <span style={{ opacity: "var(--sm-label-opacity, 1)" }}>{fadingPart}</span>
        )}
      </h2>
      {children !== undefined ? (
        <Popover onOpenChange={(open) => setHeaderMenuOpen(open)} open={isHeaderMenuOpen}>
          <PopoverEllipseTrigger
            isOpen={isHeaderMenuOpen}
            variant="ghost"
            orientation="horizontal"
            className="group-hover/side-header:text-text-bright"
          />
          <PopoverContent
            className="min-w-max overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
            align="start"
          >
            <div className="flex flex-col gap-1 p-1">{children}</div>
          </PopoverContent>
        </Popover>
      ) : null}
    </motion.div>
  );
}
