import { motion } from "framer-motion";
import { useState } from "react";

export function RightSideMenuIcon({ className }: { className?: string }) {
  const [hovered, setHovered] = useState(false);

  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <motion.rect
        y="6"
        height="12"
        rx="1"
        fill="currentColor"
        initial={false}
        animate={{ x: hovered ? 17 : 13, width: hovered ? 1 : 5 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
      />
    </svg>
  );
}
