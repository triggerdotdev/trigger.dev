import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { useThemeColor } from "~/hooks/useThemeColor";
import { cn } from "~/utils/cn";

export function FreePlanUsage({ to, percentage }: { to: string; percentage: number }) {
  const cappedPercentage = Math.min(percentage, 1);
  const widthProgress = useMotionValue(cappedPercentage * 100);
  // Resolved to concrete colors - framer-motion can't interpolate var() strings
  const successColor = useThemeColor("--color-success", "#28bf5c");
  const warningColor = useThemeColor("--color-warning", "#f59e0b");
  const errorColor = useThemeColor("--color-error", "#e11d48");
  const color = useTransform(
    widthProgress,
    [0, 74, 75, 95, 100],
    [successColor, successColor, warningColor, errorColor, errorColor]
  );

  const hasHitLimit = cappedPercentage >= 1;

  return (
    <div
      className={cn(
        "rounded border border-grid-bright bg-background-hover p-2.5",
        hasHitLimit && "border-error/40"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <ArrowUpCircleIcon className="h-5 w-5 shrink-0 text-text-dimmed" />
          <span className="truncate text-2sm text-text-bright">Free Plan</span>
        </div>
        <Link to={to} className="shrink-0 text-2sm text-text-link focus-custom">
          Upgrade
        </Link>
      </div>
      <div className="relative mt-3 h-1 rounded-full bg-background-dimmed">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: cappedPercentage * 100 + "%" }}
          style={{
            backgroundColor: color,
          }}
          transition={{ duration: 1, type: "spring" }}
          className={cn("absolute left-0 top-0 h-full rounded-full")}
        />
      </div>
    </div>
  );
}
