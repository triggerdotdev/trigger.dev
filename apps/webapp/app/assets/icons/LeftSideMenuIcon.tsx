import { motion } from "framer-motion";
import { useState } from "react";

export function LeftSideMenuIcon({
  className,
  hovered: controlledHovered,
}: {
  className?: string;
  /**
   * When provided, the shape animation is driven by this prop (e.g. from a
   * parent button's hover). When omitted, the icon animates on its own hover.
   */
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
      {/* Animate a transform (scaleX) rather than the SVG `width` attribute:
          framer snaps the first animation of an SVG geometry attribute after it
          has been idle, whereas transforms animate reliably. Anchoring the origin
          to the left edge collapses the panel from right to left. */}
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
