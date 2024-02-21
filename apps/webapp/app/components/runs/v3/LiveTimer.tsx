import { formatDuration } from "@trigger.dev/core/v3";
import { useState, useEffect } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";

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
  }, [startTime]);

  return (
    <Paragraph variant="extra-small" className="whitespace-nowrap tabular-nums">
      {formatDuration(startTime, now, {
        style: "short",
        maxDecimalPoints: 0,
        units: ["d", "h", "m", "s"],
      })}
    </Paragraph>
  );
}
