import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect } from "react";

export function AnimatedNumber({ value }: { value: number }) {
  const motionValue = useMotionValue(value);
  let display = useTransform(motionValue, (current) => Math.round(current).toLocaleString());

  useEffect(() => {
    animate(motionValue, value, {
      duration: 0.5,
      ease: "easeInOut",
    });
  }, [value]);

  return <motion.span>{display}</motion.span>;
}
