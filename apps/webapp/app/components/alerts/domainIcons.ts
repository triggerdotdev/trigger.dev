import { BugIcon } from "~/assets/icons/BugIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { RadarPulseIcon } from "~/assets/icons/RadarPulseIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import type { RenderIcon } from "~/components/primitives/Icon";

export type AlertArea = "queues" | "errors" | "health" | "runs";

export const WATCHING_TOOLTIP =
  "What this alert keeps an eye on: queues, runs, errors, or environment health. It decides which metrics you can pick and which scopes (queue, task, error group) are available.";

export const AREA_LABEL: Record<AlertArea, string> = {
  queues: "Queues",
  errors: "Errors",
  health: "Health",
  runs: "Runs",
};

export const AREA_ICON: Record<AlertArea, RenderIcon> = {
  queues: QueuesIcon,
  errors: BugIcon,
  health: RadarPulseIcon,
  runs: RunsIcon,
};

export function isAlertArea(value: string): value is AlertArea {
  return value in AREA_LABEL;
}
