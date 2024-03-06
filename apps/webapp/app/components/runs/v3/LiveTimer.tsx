import { formatDuration } from "@trigger.dev/core/v3";
import { useState, useEffect } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

export function LiveTimer({
  startTime,
  endTime,
  updateInterval = 250,
  className,
}: {
  startTime: Date;
  endTime?: Date;
  updateInterval?: number;
  className?: string;
}) {
  const [now, setNow] = useState<Date>();

  useEffect(() => {
    const interval = setInterval(() => {
      const date = new Date();
      setNow(date);

      if (endTime && date > endTime) {
        clearInterval(interval);
      }
    }, updateInterval);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <Paragraph variant="extra-small" className={cn("whitespace-nowrap tabular-nums", className)}>
      {formatDuration(startTime, now, {
        style: "short",
        maxDecimalPoints: 0,
        units: ["d", "h", "m", "s"],
      })}
    </Paragraph>
  );
}

export function LiveCountUp({
  lastUpdated,
  updateInterval = 250,
  className,
}: {
  lastUpdated: Date;
  updateInterval?: number;
  className?: string;
}) {
  const [now, setNow] = useState<Date>();

  useEffect(() => {
    const interval = setInterval(() => {
      const date = new Date();
      setNow(date);
    }, updateInterval);

    return () => clearInterval(interval);
  }, [lastUpdated]);

  return (
    <>
      {formatDuration(lastUpdated, now, {
        style: "short",
        maxDecimalPoints: 0,
        units: ["m", "s"],
      })}
    </>
  );
}
