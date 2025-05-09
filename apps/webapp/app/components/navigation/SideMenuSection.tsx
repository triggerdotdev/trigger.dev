import { AnimatePresence, motion } from "framer-motion";
import React, { useCallback, useState } from "react";
import { ToggleArrowIcon } from "~/assets/icons/ToggleArrowIcon";

type Props = {
  title: string;
  initialCollapsed?: boolean;
  onCollapseToggle?: (isCollapsed: boolean) => void;
  children: React.ReactNode;
};

/** A collapsible section for the side menu
 * The collapsed state is passed in as a prop, and there's a callback when it's toggled so we can save the state.
 */
export function SideMenuSection({
  title,
  initialCollapsed = false,
  onCollapseToggle,
  children,
}: Props) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);

  const handleToggle = useCallback(() => {
    const newIsCollapsed = !isCollapsed;
    setIsCollapsed(newIsCollapsed);
    onCollapseToggle?.(newIsCollapsed);
  }, [isCollapsed, onCollapseToggle]);

  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-1 rounded-sm py-1 pl-1.5 text-text-dimmed transition hover:bg-charcoal-750 hover:text-text-bright"
        onClick={handleToggle}
      >
        <h2 className="text-xs">{title}</h2>
        <motion.div
          initial={isCollapsed}
          animate={{ rotate: isCollapsed ? -90 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ToggleArrowIcon className="size-2" />
        </motion.div>
      </div>
      <AnimatePresence initial={false}>
        <motion.div
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
