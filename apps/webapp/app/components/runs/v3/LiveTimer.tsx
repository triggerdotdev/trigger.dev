import { formatDuration } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";

export function LiveTimer({
  startTime,
  endTime,
  updateInterval = 250,
}: {
  startTime: Date;
  endTime?: Date;
  updateInterval?: number;
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
  }, [startTime, endTime, updateInterval]);

  return (
    <>
      {formatDuration(startTime, endTime ?? now, {
        style: "short",
        maxDecimalPoints: 0,
        units: ["d", "h", "m", "s"],
      })}
    </>
  );
}

export function LiveCountdown({
  endTime,
  updateInterval = 100,
}: {
  endTime: Date;
  updateInterval?: number;
}) {
  const [now, setNow] = useState<Date>();

  useEffect(() => {
    const interval = setInterval(() => {
      const date = new Date();
      setNow(date);

      if (date > endTime) {
        clearInterval(interval);
      }
    }, updateInterval);

    return () => clearInterval(interval);
  }, [endTime, updateInterval]);

  return (
    <>
      {formatDuration(now, endTime, {
        style: "short",
        maxDecimalPoints: 0,
        units: ["d", "h", "m", "s"],
        maxUnits: 4,
      })}
    </>
  );
}
