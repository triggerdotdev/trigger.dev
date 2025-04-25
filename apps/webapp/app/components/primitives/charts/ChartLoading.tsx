import { motion } from "framer-motion";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";
import { Spinner } from "../Spinner";
import { useDateRange } from "./DateRangeContext";

export function ChartBarLoading() {
  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 flex items-center gap-2">
        <Spinner className="size-6" />
        <Paragraph variant="base/bright">Loading data…</Paragraph>
      </div>
    </div>
  );
}

export function ChartNoData() {
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 flex flex-col items-center gap-2">
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
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 flex flex-col items-center gap-2">
        <Paragraph variant="small/bright">Chart not applicable</Paragraph>
        <Paragraph variant="small" spacing>
          Your current filter settings don't apply to this chart's data type.
        </Paragraph>
        <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
          Clear filters
        </Button>
      </div>
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
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: `${height}%`, opacity: 1 }}
              transition={{
                type: "spring",
                stiffness: 120,
                damping: 14,
                mass: 1,
                delay: 0.1 + i * 0.02,
              }}
            />
          );
        })}
      </motion.div>
      <motion.div
        className="mt-2 flex flex-col justify-center gap-1"
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          type: "spring",
          stiffness: 100,
          damping: 15,
          delay: 0.2,
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <motion.div
            className="flex items-center gap-1"
            key={i}
            initial={{ x: -10, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 12,
              delay: 0.3 + i * 0.08,
            }}
          >
            <div className="h-5 w-2 rounded-sm bg-charcoal-750/50" />
            <div className="h-5 w-full rounded-sm bg-charcoal-750/50" />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
