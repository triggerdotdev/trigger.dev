import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useMemo } from "react";

/**
 * Determines the number of decimal places to display based on the value.
 * - For integers or large numbers (>=100), no decimals
 * - For numbers >= 10, 1 decimal place
 * - For numbers >= 1, 2 decimal places
 * - For smaller numbers, up to 4 decimal places
 */
function getDecimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;

  const absValue = Math.abs(value);
  if (absValue >= 100) return 0;
  if (absValue >= 10) return 1;
  if (absValue >= 1) return 2;
  if (absValue >= 0.1) return 3;
  return 4;
}

export function AnimatedNumber({
  value,
  duration = 0.5,
  decimalPlaces,
}: {
  value: number;
  duration?: number;
  /** Number of decimal places to display. If not provided, auto-detects based on value. */
  decimalPlaces?: number;
}) {
  const motionValue = useMotionValue(value);

  // Determine decimal places - use provided value or auto-detect
  const decimals = useMemo(
    () => (decimalPlaces !== undefined ? decimalPlaces : getDecimalPlaces(value)),
    [decimalPlaces, value]
  );

  const display = useTransform(motionValue, (current) => {
    if (decimals === 0) {
      return Math.round(current).toLocaleString();
    }
    return current.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  });

  useEffect(() => {
    animate(motionValue, value, {
      duration,
      ease: "easeInOut",
    });
  }, [value, duration]);

  return <motion.span>{display}</motion.span>;
}
