import { ChartBarIcon } from "~/assets/icons/ChartBarIcon";
import { RadarPulseIcon } from "~/assets/icons/RadarPulseIcon";
import {
  SegmentedToggle,
  type SegmentedToggleSegment,
} from "~/components/primitives/SegmentedToggle";

export type HealthView = "together" | "separate";

const HEALTH_VIEW_SEGMENTS: SegmentedToggleSegment<HealthView>[] = [
  {
    value: "together",
    label: "Health",
    ariaLabel: "Health — Combined pass/fail health",
    icon: <RadarPulseIcon className="size-3" />,
  },
  {
    value: "separate",
    label: "Metrics",
    ariaLabel: "Metrics — Each metric separately",
    icon: <ChartBarIcon className="size-3" />,
  },
];

export function HealthViewToggle({
  value,
  onChange,
}: {
  value: HealthView;
  onChange: (value: HealthView) => void;
}) {
  return (
    <SegmentedToggle
      segments={HEALTH_VIEW_SEGMENTS}
      value={value}
      onChange={onChange}
      ariaLabel="Health chart view"
    />
  );
}
