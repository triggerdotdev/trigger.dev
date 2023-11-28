import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { Paragraph } from "../primitives/Paragraph";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";

export function FreePlanUsage({ to, percentage }: { to: string; percentage: number }) {
  const widthProgress = useMotionValue(percentage * 100);
  const color = useTransform(
    widthProgress,
    [0, 74, 75, 95, 100],
    ["#22C55E", "#22C55E", "#F59E0B", "#F43F5E", "#F43F5E"]
  );

  return (
    <div className="rounded border border-slate-900 bg-[#101722] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <ArrowUpCircleIcon className="h-5 w-5 text-dimmed" />
          <Paragraph className="text-2sm text-bright">Free Plan</Paragraph>
        </div>
        <Link to={to} className="text-2sm text-indigo-500">
          Learn more
        </Link>
      </div>
      <div className="relative mt-3 h-1 rounded-full bg-[#0B1018]">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: percentage * 100 + "%" }}
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
