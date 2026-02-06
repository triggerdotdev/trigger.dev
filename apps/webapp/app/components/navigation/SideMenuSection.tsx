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
        {/* Header - fades out when sidebar is collapsed */}
        <motion.div
          className="group/section flex cursor-pointer items-center justify-between overflow-hidden rounded-sm py-1 pl-1.5 pr-1 transition hover:bg-charcoal-750"
          initial={false}
          animate={{
            opacity: isSideMenuCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          onClick={isSideMenuCollapsed ? undefined : handleToggle}
          style={{ cursor: isSideMenuCollapsed ? "default" : "pointer" }}
        >
          <div className="flex items-center gap-1 text-text-dimmed transition group-hover/section:text-text-bright">
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
        </motion.div>
        {/* Divider - absolutely positioned, visible when sidebar is collapsed but section is expanded */}
        <motion.div
          className="absolute left-2 right-2 top-1 h-px bg-charcoal-600"
          initial={false}
          animate={{
            opacity: isSideMenuCollapsed && !isCollapsed ? 1 : 0,
          }}
          transition={{ duration: 0.15, ease: "easeOut" }}
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
