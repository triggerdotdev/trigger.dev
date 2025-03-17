import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { Paragraph } from "../primitives/Paragraph";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";

export function FreePlanUsage({ to, percentage }: { to: string; percentage: number }) {
  const cappedPercentage = Math.min(percentage, 1);
  const widthProgress = useMotionValue(cappedPercentage * 100);
  const color = useTransform(
    widthProgress,
    [0, 74, 75, 95, 100],
    ["#22C55E", "#22C55E", "#F59E0B", "#F43F5E", "#F43F5E"]
  );

  const hasHitLimit = cappedPercentage >= 1;

  return (
    <div
      className={cn(
        "rounded border border-charcoal-700 bg-charcoal-750 p-2.5",
        hasHitLimit && "border-error/40"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <ArrowUpCircleIcon className="h-5 w-5 text-text-dimmed" />
          <span className="text-2sm text-text-bright">Free Plan</span>
        </div>
        <Link to={to} className="text-2sm text-text-link focus-custom">
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
