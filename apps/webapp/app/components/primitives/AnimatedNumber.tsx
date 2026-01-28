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

/**
 * Sanitizes a decimal places value to ensure it's valid for toLocaleString.
 * - Coerces to a finite number (handles NaN, Infinity, -Infinity)
 * - Rounds to an integer
 * - Clamps to the valid 0-20 range for toLocaleString options
 */
function sanitizeDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) {
    return 0;
  }
  return Math.min(20, Math.max(0, Math.round(decimals)));
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

  // Determine decimal places - use provided value or auto-detect, then sanitize
  const safeDecimals = useMemo(() => {
    const rawDecimals = decimalPlaces !== undefined ? decimalPlaces : getDecimalPlaces(value);
    return sanitizeDecimals(rawDecimals);
  }, [decimalPlaces, value]);

  const display = useTransform(motionValue, (current) => {
    if (safeDecimals === 0) {
      return Math.round(current).toLocaleString();
    }
    return current.toLocaleString(undefined, {
      minimumFractionDigits: safeDecimals,
      maximumFractionDigits: safeDecimals,
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
