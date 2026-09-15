import { motion } from "framer-motion";
import { useState } from "react";

export function LeftSideMenuIcon({
  className,
  hovered: controlledHovered,
}: {
  className?: string;
  /** Drives the animation when provided (e.g. parent hover); otherwise the icon uses its own hover. */
  hovered?: boolean;
}) {
  const [internalHovered, setInternalHovered] = useState(false);
  const isControlled = controlledHovered !== undefined;
  const hovered = isControlled ? controlledHovered : internalHovered;

  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      onMouseEnter={isControlled ? undefined : () => setInternalHovered(true)}
      onMouseLeave={isControlled ? undefined : () => setInternalHovered(false)}
    >
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      {/* Animate a transform (scaleX), not the SVG `width` attr — framer snaps the first animation
          of an idle SVG geometry attribute. Left origin collapses the panel right-to-left. */}
      <motion.rect
        x="6"
        y="6"
        width="5"
        height="12"
        rx="1"
        fill="currentColor"
        initial={false}
        style={{ originX: 0 }}
        animate={{ scaleX: hovered ? 0.2 : 1 }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
      />
    </svg>
  );
}
