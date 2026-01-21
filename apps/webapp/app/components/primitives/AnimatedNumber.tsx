import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect } from "react";

export function AnimatedNumber({ value, duration = 0.5 }: { value: number; duration?: number }) {
  const motionValue = useMotionValue(value);
  let display = useTransform(motionValue, (current) => Math.round(current).toLocaleString());

  useEffect(() => {
    animate(motionValue, value, {
      duration,
      ease: "easeInOut",
    });
  }, [value, duration]);

  return <motion.span>{display}</motion.span>;
}
