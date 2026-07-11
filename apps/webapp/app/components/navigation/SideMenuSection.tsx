import { AnimatePresence, motion } from "framer-motion";
import React, { useCallback, useState } from "react";
import { ToggleArrowIcon } from "~/assets/icons/ToggleArrowIcon";

type Props = {
  title: string;
  initialCollapsed?: boolean;
  onCollapseToggle?: (isCollapsed: boolean) => void;
  children: React.ReactNode;
  /** When true, hides the section header and shows only children */
  isSideMenuCollapsed?: boolean;
  itemSpacingClassName?: string;
  /** Optional action element (e.g., + button) to render on the right side of the header */
  headerAction?: React.ReactNode;
};

/** A collapsible section for the side menu
 * The collapsed state is passed in as a prop, and there's a callback when it's toggled so we can save the state.
 */
export function SideMenuSection({
  title,
  initialCollapsed = false,
  onCollapseToggle,
  children,
  isSideMenuCollapsed = false,
  itemSpacingClassName = "space-y-px",
  headerAction,
}: Props) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);

  const handleToggle = useCallback(() => {
    const newIsCollapsed = !isCollapsed;
    setIsCollapsed(newIsCollapsed);
    onCollapseToggle?.(newIsCollapsed);
  }, [isCollapsed, onCollapseToggle]);

  return (
    <div className="w-full overflow-hidden">
      {/* Header container - stays in DOM to preserve height */}
      <div className="relative w-full">
        {/*
          Header - fades out as the side menu narrows. Opacity is driven by the resizable
          SideMenu's `--sm-label-opacity` variable (falls back to 1 when unset) so it scrubs in
          real time while dragging. The hover background and text color snap (no transition), to
          match the nav items.
        */}
        <button
          type="button"
          // A real button so it's keyboard-operable (Enter/Space toggle natively) and shows the
          // focus-custom ring. Removed from the tab order when the side menu is collapsed, since
          // the header is hidden (the divider takes its place) and can't be toggled then.
          className="group/section flex w-full cursor-pointer items-center justify-between overflow-hidden rounded-sm py-1 pl-1.5 pr-1 hover:bg-charcoal-750 focus-custom"
          onClick={isSideMenuCollapsed ? undefined : handleToggle}
          tabIndex={isSideMenuCollapsed ? -1 : undefined}
          aria-expanded={!isCollapsed}
          style={{
            opacity: "var(--sm-label-opacity, 1)",
            cursor: isSideMenuCollapsed ? "default" : "pointer",
          }}
        >
          <div className="flex items-center gap-1 text-text-dimmed group-hover/section:text-text-bright">
            <h2 className="whitespace-nowrap text-xs">{title}</h2>
            <motion.div
              initial={isCollapsed}
              animate={{ rotate: isCollapsed ? -90 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ToggleArrowIcon className="size-2" />
            </motion.div>
          </div>
          {headerAction && <div className="flex items-center">{headerAction}</div>}
        </button>
        {/*
          Divider - absolutely positioned, fades in as the header fades out (driven by the
          `--sm-collapse` progress variable, 0 → 1). Only shown while this section is expanded.
        */}
        <div
          className="absolute left-2 right-2 top-1 h-px bg-charcoal-600"
          style={{ opacity: isCollapsed ? 0 : "var(--sm-collapse, 0)" }}
        />
      </div>
      <AnimatePresence initial={false}>
        <motion.div
          className="w-full"
          initial={isCollapsed ? "collapsed" : "expanded"}
          animate={isCollapsed ? "collapsed" : "expanded"}
          exit="collapsed"
          variants={{
            expanded: {
              height: "auto",
              transition: {
                height: { duration: 0.3, ease: "easeInOut" },
              },
            },
            collapsed: {
              height: 0,
              transition: {
                height: { duration: 0.2, ease: "easeInOut" },
              },
            },
          }}
          style={{ overflow: "hidden" }}
        >
          <motion.div
            className={`w-full ${itemSpacingClassName}`}
            variants={{
              expanded: {
                translateY: 0,
                opacity: 1,
                transition: { duration: 0.3, ease: "easeInOut" },
              },
              collapsed: {
                translateY: "-100%",
                opacity: 0,
                transition: { duration: 0.2, ease: "easeInOut" },
              },
            }}
          >
            {children}
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
