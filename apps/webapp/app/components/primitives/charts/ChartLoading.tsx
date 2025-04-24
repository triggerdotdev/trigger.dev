import { Spinner } from "../Spinner";
import { Paragraph } from "../Paragraph";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { motion } from "framer-motion";
import { Button } from "../Buttons";
import { useDateRange } from "./DateRangeContext";

export function ChartBarLoading() {
  return (
    <div className="relative grid h-full place-items-center p-4">
      <ChartBarLoadingBackground />
      <Spinner className="absolute z-10 size-6" />
    </div>
  );
}

export function ChartNoData() {
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-4">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 flex flex-col items-center gap-2 text-center">
        <Paragraph variant="small/bright">No data</Paragraph>
        <Paragraph variant="small" spacing>
          There's no data available for the filters you've set.
        </Paragraph>
        <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}

export function ChartInvalid() {
  return (
    <div className="relative grid h-full place-items-center p-4">
      <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />
      <Paragraph variant="small" className="text-text-dimmed">
        Invalid chart
      </Paragraph>
    </div>
  );
}

export function ChartLineLoading() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner className="size-6" />
    </div>
  );
}

function ChartBarLoadingBackground() {
  return (
    <motion.div
      className="flex h-full w-full flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <motion.div
        className="flex flex-1 items-end gap-1"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.1 }}
      >
        {Array.from({ length: 30 }).map((_, i) => {
          const height = Math.max(15, Math.floor(Math.random() * 100));
          return (
            <motion.div
              key={i}
              className="flex-1 rounded-sm bg-charcoal-750/50"
              style={{ height: `${height}%` }}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{
                duration: 0.4,
                delay: 0.1 + i * 0.01,
                ease: "easeOut",
              }}
            />
          );
        })}
      </motion.div>
      <motion.div
        className="mt-5 flex flex-col justify-center gap-1"
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.3 }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <motion.div
            className="flex items-center gap-1"
            key={i}
            initial={{ x: -10, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{
              duration: 0.4,
              delay: 0.4 + i * 0.1,
              ease: "easeOut",
            }}
          >
            <div className="h-6 w-4 rounded-sm bg-charcoal-750/50" />
            <div className="h-6 w-full rounded-sm bg-charcoal-750/50" />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
