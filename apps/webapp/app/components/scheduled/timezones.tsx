import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { SelectItem } from "../primitives/Select";

export function TimezoneList({ timezones }: { timezones: string[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: timezones.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
  });

  return (
    <div
      ref={parentRef}
      className="max-h-[calc(min(480px,var(--popover-available-height))-2.35rem)] overflow-y-auto overscroll-contain scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualItem) => (
          <TimezoneCell
            key={virtualItem.key}
            size={virtualItem.size}
            start={virtualItem.start}
            timezone={timezones[virtualItem.index]}
          />
        ))}
      </div>
    </div>
  );
}

function TimezoneCell({
  timezone,
  size,
  start,
}: {
  timezone: string;
  size: number;
  start: number;
}) {
  return (
    <SelectItem
      value={timezone}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: `${size}px`,
        transform: `translateY(${start}px)`,
      }}
    >
      {timezone}
    </SelectItem>
  );
}
